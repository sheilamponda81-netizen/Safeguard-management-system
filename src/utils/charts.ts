// ============================================
// LAZY LOAD CHARTS
// ============================================

let charts: any = null;

export const getCharts = async () => {
  if (!charts) {
    charts = await import('recharts');
  }
  return charts;
};

// Individual chart components
export const getLineChart = async () => {
  const { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } = await getCharts();
  return { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer };
};

export const getBarChart = async () => {
  const { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } = await getCharts();
  return { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer };
};

export const getPieChart = async () => {
  const { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } = await getCharts();
  return { PieChart, Pie, Cell, Tooltip, ResponsiveContainer };
};