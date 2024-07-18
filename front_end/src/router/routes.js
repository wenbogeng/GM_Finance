import NotFound from "@/pages/NotFoundPage.vue";
import TradingLayout from "@/layout/trading/TradingLayout";

const routes = [
  {
    path: "/",
    component: TradingLayout,
    children: [
    ]
  },
  { path: "*", component: NotFound },
];

export default routes;
