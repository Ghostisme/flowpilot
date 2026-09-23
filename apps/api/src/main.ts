import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import express from "express";
import type { Request, Response } from "express";
import { AppModule } from "./app.module.js";

// Vercel Serverless 函数需要导出一个 handler
let cachedApp: any = null;

async function bootstrap() {
  if (cachedApp) {
    return cachedApp;
  }

  const expressApp = express();

  // 信任 Vercel 代理
  expressApp.set("trust proxy", 1);

  const app = await NestFactory.create(
    AppModule,
    new ExpressAdapter(expressApp),
    { cors: false }
  );

  // 从环境变量读取允许的源
  const originsEnv = process.env.CORS_ORIGINS ?? "http://localhost:3000";
  console.log("[CORS] Raw CORS_ORIGINS from env:", originsEnv);

  const origins = originsEnv
    .split(",")
    .map((origin) => origin.trim())
    .map((origin) => origin.replace(/\/$/, "")) // 移除末尾的斜杠
    .filter(Boolean);

  console.log("[CORS] Parsed allowed origins:", origins);

  app.setGlobalPrefix("api");

  // CORS 配置 - 适配 Vercel Serverless
  app.enableCors({
    origin: (requestOrigin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      console.log("[CORS] Request from origin:", requestOrigin);

      // 无 origin 的请求(如服务端请求、Postman)
      if (!requestOrigin) {
        console.log("[CORS] No origin header, allowing request");
        return callback(null, true);
      }

      // 检查是否在允许列表中
      if (origins.includes(requestOrigin)) {
        console.log("[CORS] Origin allowed:", requestOrigin);
        return callback(null, true);
      }

      // 开发环境允许所有 localhost
      if (requestOrigin.startsWith("http://localhost:") ||
          requestOrigin.startsWith("https://localhost:")) {
        console.log("[CORS] Localhost origin allowed:", requestOrigin);
        return callback(null, true);
      }

      console.warn("[CORS] Origin rejected:", requestOrigin);
      callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowedHeaders: [
      "Content-Type",
      "X-FlowPilot-Event-Secret",
      "Authorization",
      "Accept",
      "Origin",
    ],
    credentials: true,
    exposedHeaders: ["Content-Length", "X-Request-Id"],
    maxAge: 86400, // 预检请求缓存 24 小时
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  app.enableShutdownHooks();

  await app.init();

  cachedApp = expressApp;
  return expressApp;
}

// 只有真正跑在 Vercel Serverless 里时才不主动监听端口 —— 那种环境下由平台
// 调用下面导出的 handler，自己 listen 会冲突。
//
// 判断依据必须是"是不是 Serverless"，不能是 NODE_ENV。早先这里写的是
// `NODE_ENV !== "production"`，导致任何以 NODE_ENV=production 启动的常驻
// 进程（Docker 镜像、VPS、PM2）都会静默地不监听任何端口：容器能起来、日志
// 干净、退出码为 0，但端口上什么都没有，反代只会得到 502。
// VERCEL 这个环境变量由 Vercel 平台自动注入，本地和自建服务器都不会有。
const isServerless = Boolean(process.env.VERCEL);

if (!isServerless) {
  const port = Number(process.env.PORT ?? 3001);
  bootstrap().then((app) => {
    app.listen(port, "0.0.0.0", () => {
      console.log(`FlowPilot API listening on http://0.0.0.0:${port}/api`);
    });
  });
}

// Vercel Serverless 函数 handler
export default async (req: Request, res: Response) => {
  const app = await bootstrap();
  return app(req, res);
};
