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

// 本地开发环境
if (process.env.NODE_ENV !== "production") {
  const port = Number(process.env.PORT ?? 3001);
  bootstrap().then((app) => {
    app.listen(port, "0.0.0.0", () => {
      console.log(`FlowPilot API listening on http://localhost:${port}/api`);
    });
  });
}

// Vercel Serverless 函数 handler
export default async (req: Request, res: Response) => {
  const app = await bootstrap();
  return app(req, res);
};
