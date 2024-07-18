import { Command, Console } from "nestjs-console";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import * as bcrypt from "bcrypt";
const {
  RPCSubprovider,
  Web3ProviderEngine,
  PrivateKeyWalletSubprovider,
} = require("@0x/subproviders");
const { providerUtils } = require("@0x/utils");
const { Web3Wrapper } = require("@0x/web3-wrapper");
const BigNumber = require("bignumber.js");
import { LimitOrder, SignatureType } from "@0x/protocol-utils";

import { UserRepository } from "src/models/repositories/user.repository";
import { User, UserDocument, UserRole } from "src/models/schemas/user.schema";
import { Trade, TradeDocument } from "src/models/schemas/trade.schema";
import { Token, TokenDocument } from "src/models/schemas/token.schema";
import { Pair, PairDocument, PairStatus } from "src/models/schemas/pair.schema";
import {
  Order,
  OrderDocument,
  OrderStatus,
  OrderType,
} from "src/models/schemas/order.schema";
import { EventDocument } from "src/models/schemas/event.schema";
import { TradeRepository } from "src/models/repositories/trade.repository";
import { TokenRepository } from "src/models/repositories/token.repository";
import { PairRepository } from "src/models/repositories/pair.repository";
import { OrderRepository } from "src/models/repositories/order.repository";
import { EventRepository } from "src/models/repositories/event.repository";
import { Binance } from "src/blockchains/binance";
import {
  getRandomPriceByRule,
  randomIntFromInterval,
  sleep,
} from "src/helper/common";
import { SocketEmitter } from "src/socket/socket-emitter";
import { TradeService } from "src/modules/trade/trade.service";
import {
  OHLCV,
  OHLCVDocument,
  OHLCVType,
} from "src/models/schemas/ohlcv.schema";
import { OHLCVRepository } from "src/models/repositories/ohlcv.repository";

@Console()
export class SeedConsole {
  private userRepository: UserRepository;
  private tradeRepository: TradeRepository;
  private tokenRepository: TokenRepository;
  private pairRepository: PairRepository;
  private orderRepository: OrderRepository;
  private eventRepository: EventRepository;
  private ohlcvRepository: OHLCVRepository;

  constructor(
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @InjectModel(Trade.name)
    private readonly tradeModel: Model<TradeDocument>,
    @InjectModel(Token.name)
    private readonly tokenModel: Model<TokenDocument>,
    @InjectModel(Pair.name)
    private readonly pairModel: Model<PairDocument>,
    @InjectModel(Order.name)
    private readonly orderModel: Model<OrderDocument>,
    @InjectModel(Event.name)
    private readonly eventModel: Model<EventDocument>,
    @InjectModel(OHLCV.name)
    private readonly ohlcvModel: Model<OHLCVDocument>
  ) {
    this.userRepository = new UserRepository(this.userModel);
    this.tradeRepository = new TradeRepository(this.tradeModel);
    this.tokenRepository = new TokenRepository(this.tokenModel);
    this.pairRepository = new PairRepository(this.pairModel);
    this.orderRepository = new OrderRepository(this.orderModel);
    this.eventRepository = new EventRepository(this.eventModel);
    this.ohlcvRepository = new OHLCVRepository(this.ohlcvModel);
  }

  private async deleteAllDataOnDatabase(): Promise<void> {
    await this.userRepository.deleteAll();
    await this.tradeRepository.deleteAll();
    await this.tokenRepository.deleteAll();
    await this.pairRepository.deleteAll();
    await this.orderRepository.deleteAll();
    await this.eventRepository.deleteAll();
  }

  private async seedAdminUser(): Promise<void> {
    const newUser = new User();
    newUser.email = process.env.ADMIN_EMAIL;
    newUser.password = await bcrypt.hash(
      process.env.ADMIN_PASSWORD,
      Number(process.env.SALT_OR_ROUNDS)
    );
    newUser.role = UserRole.Admin;
    await this.userRepository.save(newUser);
  }

  private async seedTokens(): Promise<void> {
    const baseTokenInformation = await Binance.getInstance().getERC20TokenInfo(
      process.env.BASE_TOKEN_FOR_TEST
    );
    const newBaseToken = new Token();
    newBaseToken.name = baseTokenInformation.name;
    newBaseToken.symbol = baseTokenInformation.symbol;
    newBaseToken.decimals = baseTokenInformation.decimals;
    newBaseToken.address = process.env.BASE_TOKEN_FOR_TEST.toLowerCase();
    await this.tokenRepository.save(newBaseToken);

    const quoteTokenInformation = await Binance.getInstance().getERC20TokenInfo(
      process.env.QUOTE_TOKEN_FOR_TEST
    );
    const newQuoteToken = new Token();
    newQuoteToken.name = quoteTokenInformation.name;
    newQuoteToken.symbol = quoteTokenInformation.symbol;
    newQuoteToken.decimals = quoteTokenInformation.decimals;
    newQuoteToken.address = process.env.QUOTE_TOKEN_FOR_TEST.toLowerCase();
    await this.tokenRepository.save(newQuoteToken);
  }

  private async seedPair(): Promise<void> {
    const baseToken = await this.tokenRepository.getTokenByAddress(
      process.env.BASE_TOKEN_FOR_TEST.toLowerCase()
    );
    const quoteToken = await this.tokenRepository.getTokenByAddress(
      process.env.QUOTE_TOKEN_FOR_TEST.toLowerCase()
    );
    const newPair = new Pair();
    newPair.name = `${baseToken.symbol} / ${quoteToken.symbol}`;
    newPair.baseTokenAddress = baseToken.address;
    newPair.quoteTokenAddress = quoteToken.address;
    newPair.status = PairStatus.Active;
    await this.pairRepository.save(newPair);
  }

  private async calculateOHLCVBySeedTrade(
    ohlcv: OHLCV,
    trade: Trade,
    ohlcvType: OHLCVType,
    isUpdateImmediately = false
  ): Promise<OHLCV> {
    if (isUpdateImmediately) {
      const latestOHLCV = await this.ohlcvRepository.getLatestOHLCVByType(
        trade.pairId,
        ohlcvType
      );
      const ohlcvCombined = TradeService.combineOHLCVWithTrade(
        latestOHLCV,
        trade,
        ohlcvType
      );
      return this.ohlcvRepository.save(ohlcvCombined.ohlcv);
    } else {
      const ohlcvCombined = TradeService.combineOHLCVWithTrade(
        ohlcv,
        trade,
        ohlcvType
      );
      if (ohlcvCombined.isNext && ohlcv) {
        await this.ohlcvRepository.save(ohlcv);
      }
      ohlcv = ohlcvCombined.ohlcv;
      return ohlcv;
    }
  }

  public static async mintTokenForTestingAccounts(
    tokenAddress: string
  ): Promise<void> {
    const testingAmountMint = new BigNumber(1000000)
      .times(new BigNumber(10).pow(18))
      .toFixed();
    await Binance.getInstance().mintTokenForTest(
      process.env.ACCOUNT_ADDRESS_TEST_1,
      testingAmountMint,
      tokenAddress
    );
    await Binance.getInstance().mintTokenForTest(
      process.env.ACCOUNT_ADDRESS_TEST_2,
      testingAmountMint,
      tokenAddress
    );
    await Binance.getInstance().mintTokenForTest(
      process.env.ACCOUNT_ADDRESS_TEST_3,
      testingAmountMint,
      tokenAddress
    );
    await Binance.getInstance().mintTokenForTest(
      process.env.ACCOUNT_ADDRESS_TEST_4,
      testingAmountMint,
      tokenAddress
    );
    await Binance.getInstance().mintTokenForTest(
      process.env.ACCOUNT_ADDRESS_TEST_5,
      testingAmountMint,
      tokenAddress
    );
    await Binance.getInstance().mintTokenForTest(
      process.env.ACCOUNT_ADDRESS_TEST_6,
      testingAmountMint,
      tokenAddress
    );
    await Binance.getInstance().mintTokenForTest(
      process.env.ACCOUNT_ADDRESS_TEST_7,
      testingAmountMint,
      tokenAddress
    );
    await Binance.getInstance().mintTokenForTest(
      process.env.ACCOUNT_ADDRESS_TEST_8,
      testingAmountMint,
      tokenAddress
    );
    await Binance.getInstance().mintTokenForTest(
      process.env.ACCOUNT_ADDRESS_TEST_9,
      testingAmountMint,
      tokenAddress
    );
    await Binance.getInstance().mintTokenForTest(
      process.env.ACCOUNT_ADDRESS_TEST_10,
      testingAmountMint,
      tokenAddress
    );
  }

  @Command({ command: "seed-data-for-test" })
  async seedDataForTest(): Promise<void> {
    await this.deleteAllDataOnDatabase();
    await this.seedAdminUser();
    await this.seedTokens();
    await this.seedPair();
    await SeedConsole.mintTokenForTestingAccounts(
      process.env.BASE_TOKEN_FOR_TEST
    );
    await SeedConsole.mintTokenForTestingAccounts(
      process.env.QUOTE_TOKEN_FOR_TEST
    );
    console.log("Seeding data done. Exist process seeding");
    process.exit();
  }

  private static async createRandomOrder(
    makerAddress: string,
    previousPrice: number
  ): Promise<{
    limitOrder: LimitOrder;
    orderType: OrderType;
    price: number;
  }> {
    // 1 for buying and 2 for selling
    const randomNumber = randomIntFromInterval(1, 2);
    // random quantity and price for order
    const price = getRandomPriceByRule(previousPrice, 1);
    const amount = randomIntFromInterval(1, 10);
    const total = price * amount;

    const limitOrder = new LimitOrder({
      chainId: Number(process.env.BSC_CHAIN_ID),
      verifyingContract: process.env.VERIFY_SMART_CONTRACT_ADDRESS,
      maker: makerAddress,
      taker: "0x0000000000000000000000000000000000000000",
      makerToken:
        randomNumber === 1
          ? process.env.QUOTE_TOKEN_FOR_TEST
          : process.env.BASE_TOKEN_FOR_TEST,
      takerToken:
        randomNumber === 1
          ? process.env.BASE_TOKEN_FOR_TEST
          : process.env.QUOTE_TOKEN_FOR_TEST,
      makerAmount:
        randomNumber === 1
          ? new BigNumber(total).times(new BigNumber(10).pow(18)).toFixed()
          : new BigNumber(amount).times(new BigNumber(10).pow(18)).toFixed(),
      takerAmount:
        randomNumber === 1
          ? new BigNumber(amount).times(new BigNumber(10).pow(18)).toFixed()
          : new BigNumber(total).times(new BigNumber(10).pow(18)).toFixed(),
      takerTokenFeeAmount: new BigNumber(0).toString(),
      sender: "0x0000000000000000000000000000000000000000",
      feeRecipient: "0x0000000000000000000000000000000000000000",
      // @ts-ignore
      expiry: Math.floor(Date.now() / 1000 + 3000),
      pool: "0x0000000000000000000000000000000000000000000000000000000000000000",
      // @ts-ignore
      salt: Date.now().toString(),
    });
    return {
      limitOrder: limitOrder,
      orderType: randomNumber === 1 ? OrderType.BuyOrder : OrderType.SellOrder,
      price: price,
    };
  }

  private static async prepareOrderToBackend(
    limitOrder: LimitOrder,
    orderType: OrderType,
    signature: string,
    pairId: string,
    price: number
  ): Promise<Order> {
    const newOrder = new Order();
    newOrder.orderHash = limitOrder.getHash();
    newOrder.type = orderType;
    newOrder.chainId = Number(process.env.BSC_CHAIN_ID);
    newOrder.verifyingContract =
      process.env.VERIFY_SMART_CONTRACT_ADDRESS.toLowerCase();
    newOrder.price = price.toString();
    newOrder.maker = limitOrder.maker.toLowerCase();
    newOrder.taker = limitOrder.taker.toLowerCase();
    newOrder.makerToken = limitOrder.makerToken.toLowerCase();
    newOrder.takerToken = limitOrder.takerToken.toLowerCase();
    newOrder.makerAmount = limitOrder.makerAmount.toString();
    newOrder.takerAmount = limitOrder.takerAmount.toString();
    newOrder.takerTokenFeeAmount = limitOrder.takerTokenFeeAmount.toString();
    newOrder.sender = limitOrder.sender;
    newOrder.feeRecipient = limitOrder.feeRecipient;
    newOrder.expiry = Number(limitOrder.expiry);
    newOrder.pool = limitOrder.pool;
    newOrder.salt = limitOrder.salt.toString();
    newOrder.signature = signature;

    newOrder.status = OrderStatus.FillAble;
    newOrder.pairId = pairId;
    newOrder.remainingAmount =
      orderType === OrderType.BuyOrder
        ? limitOrder.takerAmount.toString()
        : limitOrder.makerAmount.toString();

    return newOrder;
  }

  private static async getProviderEngine() {
    const wallet = new PrivateKeyWalletSubprovider(
      process.env.ACCOUNT_PRIVATE_TEST_10,
      Number(process.env.BSC_CHAIN_ID)
    );
    const pe = new Web3ProviderEngine();
    pe.addProvider(wallet);
    pe.addProvider(new RPCSubprovider(process.env.BSC_RPC));
    providerUtils.startProviderEngine(pe);
    return pe;
  }

  @Command({
    command:
      "auto-bot-trading <makerNumber> <takerNumber> <maxPrice> <sleepTime>",
  })
  async autoBotTrading(
    makerNumber: string,
    takerNumber: string,
    maxPrice: number,
    sleepTime: number
  ): Promise<void> {
    const makerAddress = process.env[`ACCOUNT_ADDRESS_TEST_${makerNumber}`];
    const takerAddress = process.env[`ACCOUNT_ADDRESS_TEST_${takerNumber}`];
    let count = 0;
    const pe = await SeedConsole.getProviderEngine();
    const web3Wrapper = new Web3Wrapper(pe);
    const baseTokenSmartContract =
      await Binance.getInstance().createERC20ContractByToken(
        process.env.BASE_TOKEN_FOR_TEST
      );
    const quoteTokenSmartContract =
      await Binance.getInstance().createERC20ContractByToken(
        process.env.QUOTE_TOKEN_FOR_TEST
      );
    const matchingOrderSmartContract =
      await Binance.getInstance().getMatchingOrderContract();

    let previousPrice = maxPrice;
    const testingAmountMint = new BigNumber(1000000)
      .times(new BigNumber(10).pow(18))
      .toFixed();

    await quoteTokenSmartContract.methods
      .approve(process.env.ORDER_SMART_CONTRACT_ADDRESS, testingAmountMint)
      .send({
        from: makerAddress,
      });
    await baseTokenSmartContract.methods
      .approve(process.env.ORDER_SMART_CONTRACT_ADDRESS, testingAmountMint)
      .send({
        from: takerAddress,
      });
    await baseTokenSmartContract.methods
      .approve(process.env.ORDER_SMART_CONTRACT_ADDRESS, testingAmountMint)
      .send({
        from: makerAddress,
      });

    await quoteTokenSmartContract.methods
      .approve(process.env.ORDER_SMART_CONTRACT_ADDRESS, testingAmountMint)
      .send({
        from: takerAddress,
      });

    while (1) {
      const { limitOrder, orderType, price } =
        await SeedConsole.createRandomOrder(makerAddress, previousPrice);
      previousPrice = price;
      const signature = await limitOrder.getSignatureWithProviderAsync(
        web3Wrapper.getProvider(),
        SignatureType.EIP712,
        makerAddress
      );

      const baseTokenAddress =
        orderType === OrderType.BuyOrder
          ? limitOrder.takerToken
          : limitOrder.makerToken;
      const quoteTokenAddress =
        orderType === OrderType.BuyOrder
          ? limitOrder.makerToken
          : limitOrder.takerToken;

      const pair = await this.pairRepository.getPairByBaseQuoteToken(
        baseTokenAddress.toLowerCase(),
        quoteTokenAddress.toLowerCase()
      );

      if (!pair) {
        console.log("No pair found");
        await sleep(3000);
        continue;
      }

      const orderForBackend = await SeedConsole.prepareOrderToBackend(
        limitOrder,
        orderType,
        JSON.stringify(signature),
        pair._id.toString(),
        price
      );

      const orderCreated = await this.orderRepository.save(orderForBackend);
      SocketEmitter.getInstance().emitNewOrderCreated(orderCreated);

      await matchingOrderSmartContract.methods
        .fillLimitOrder(
          limitOrder,
          signature,
          new BigNumber(limitOrder.takerAmount).div(2).toFixed()
        )
        .send({
          from: takerAddress,
          value: 0,
          gas: 800000,
          gasPrice: 20e9,
        });
      console.log(`Bot trading complete process ${count++}`);
      await sleep(sleepTime);
    }
  }

  @Command({
    command: "seed-trades",
  })
  async seedTrades(): Promise<void> {
    let pairId = "64ca637a5dc04241fff1d209";
    const latestTrade = await this.tradeRepository.getLatestTradeHappenedByPair(
      pairId,
      1
    );
    let timestamp =
      latestTrade.length === 0
        ? new Date(Date.now() - 86400000 * 1080).getTime()
        : latestTrade[0].timestamp;
    let previousPrice = 15;
    let count = 0;
    let saveTrades = [];

    let ohlcvMinute = await this.ohlcvRepository.getLatestOHLCVByType(
      pairId,
      OHLCVType.Minute
    );
    let ohlcv15Minute = await this.ohlcvRepository.getLatestOHLCVByType(
      pairId,
      OHLCVType.FifteenMinutes
    );
    let ohlcvHour = await this.ohlcvRepository.getLatestOHLCVByType(
      pairId,
      OHLCVType.Hour
    );
    let ohlcv4Hour = await this.ohlcvRepository.getLatestOHLCVByType(
      pairId,
      OHLCVType.FourHours
    );
    let ohlcvDay = await this.ohlcvRepository.getLatestOHLCVByType(
      pairId,
      OHLCVType.Day
    );
    let ohlcvWeek = await this.ohlcvRepository.getLatestOHLCVByType(
      pairId,
      OHLCVType.Week
    );

    while (true) {
      if (timestamp > Date.now()) {
        if (saveTrades.length > 0) {
          await this.tradeRepository.saveTrades(saveTrades);
          await this.ohlcvRepository.save(ohlcvMinute);
          await this.ohlcvRepository.save(ohlcv15Minute);
          await this.ohlcvRepository.save(ohlcvHour);
          await this.ohlcvRepository.save(ohlcv4Hour);
          await this.ohlcvRepository.save(ohlcvDay);
          await this.ohlcvRepository.save(ohlcvWeek);

          for (const trade of saveTrades) {
            await this.calculateOHLCVBySeedTrade(
              ohlcvMinute,
              trade,
              OHLCVType.Minute,
              true
            );
            await this.calculateOHLCVBySeedTrade(
              ohlcv15Minute,
              trade,
              OHLCVType.FifteenMinutes,
              true
            );
            await this.calculateOHLCVBySeedTrade(
              ohlcvHour,
              trade,
              OHLCVType.Hour,
              true
            );
            await this.calculateOHLCVBySeedTrade(
              ohlcv4Hour,
              trade,
              OHLCVType.FourHours,
              true
            );
            await this.calculateOHLCVBySeedTrade(
              ohlcvDay,
              trade,
              OHLCVType.Day,
              true
            );
            await this.calculateOHLCVBySeedTrade(
              ohlcvWeek,
              trade,
              OHLCVType.Week,
              true
            );
          }
        }
        break;
      }
      const newTrade = new Trade();
      newTrade.orderType =
        randomIntFromInterval(1, 2) === 1
          ? OrderType.BuyOrder
          : OrderType.SellOrder;
      newTrade.pairId = pairId;
      const price = getRandomPriceByRule(previousPrice, 1);
      newTrade.price = `${price}`;
      newTrade.volume = new BigNumber(randomIntFromInterval(1, 10))
        .times(new BigNumber(10).pow(18))
        .toFixed();
      newTrade.transactionId =
        "0xb225d54d8354b8d13399155bedfe6c29131a10a1d917aaea4c1ec9149c13118b";
      newTrade.maker = "0x19ef6ab7a5e9753c214462df01f77ad324da645d";
      newTrade.taker = "0x0056ea9a9c2a68d1679787a10b36acc71750093e";
      newTrade.timestamp = timestamp;
      saveTrades.push(newTrade);
      count++;

      if (count > 1000) {
        await this.tradeRepository.saveTrades(saveTrades);
        for (const trade of saveTrades) {
          ohlcvMinute = await this.calculateOHLCVBySeedTrade(
            ohlcvMinute,
            trade,
            OHLCVType.Minute
          );
          ohlcv15Minute = await this.calculateOHLCVBySeedTrade(
            ohlcv15Minute,
            trade,
            OHLCVType.FifteenMinutes
          );
          ohlcvHour = await this.calculateOHLCVBySeedTrade(
            ohlcvHour,
            trade,
            OHLCVType.Hour
          );
          ohlcv4Hour = await this.calculateOHLCVBySeedTrade(
            ohlcv4Hour,
            trade,
            OHLCVType.FourHours
          );
          ohlcvDay = await this.calculateOHLCVBySeedTrade(
            ohlcvDay,
            trade,
            OHLCVType.Day
          );
          ohlcvWeek = await this.calculateOHLCVBySeedTrade(
            ohlcvWeek,
            trade,
            OHLCVType.Week
          );
        }
        console.log(new Date(newTrade.timestamp));
        count = 0;
        saveTrades = [];
      }

      timestamp += 3000;
      if (price < 1) {
        previousPrice = 15;
      } else {
        previousPrice = price;
      }
    }
  }

  /**
   * @description This migrate batch match order feature to ZeroEx contract, so that we can call batchFillLimitOrders
   */
  @Command({
    command: "migrate-batch-order",
  })
  async migrateBatchOrder(): Promise<void> {
    const BatchMatchOrderContract =
      await Binance.getInstance().getBatchMatchOrderContract();
    const selector = BatchMatchOrderContract.methods.migrate().encodeABI();
    const ZeroContract = await Binance.getInstance().getMatchingOrderContract();
    await ZeroContract.methods
      .migrate(
        process.env.BATCH_MATCH_ORDER_ADDRESS,
        selector,
        process.env.ADMIN_WALLET_ADDRESS
      )
      .send({
        from: process.env.ADMIN_WALLET_ADDRESS,
        value: 0,
        gas: 800000,
        gasPrice: 20e9,
      });
  }
}
