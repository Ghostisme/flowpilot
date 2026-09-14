// Vercel Serverless 函数入口点
// 这个文件会被 Vercel 检测为函数入口
// 导入编译后的 main.js 并导出其 default handler

// 使用绝对路径导入,因为 Vercel 的工作目录是项目根目录
export { default } from '../dist/main.js';

