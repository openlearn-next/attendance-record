// 宿主通过 window.HostSharedDeps.Recharts 提供 recharts（外部依赖，不打进包）。
// 此处仅提供最小类型声明，供 tsc 校验通过；运行时由宿主注入真实实现。
declare module 'recharts' {
  export const BarChart: any;
  export const Bar: any;
  export const LineChart: any;
  export const Line: any;
  export const XAxis: any;
  export const YAxis: any;
  export const Tooltip: any;
  export const Legend: any;
  export const CartesianGrid: any;
  export const ResponsiveContainer: any;
}
