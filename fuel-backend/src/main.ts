import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['log', 'warn', 'error', 'debug'],
  });

  // Restrict CORS in production via CORS_ORIGINS (comma-separated allowlist,
  // e.g. "https://dashboard.example.com,https://ifs.itecknologi.com"). When
  // unset (local dev) all origins are allowed so the LAN/localhost dashboard
  // and driver PWA keep working.
  const corsOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors(corsOrigins.length ? { origin: corsOrigins } : {});

  // Serve driver-uploaded proof-of-delivery photos (outside the /api prefix,
  // so they bypass the response-envelope interceptor and stream raw).
  const uploadsDir = process.env.UPLOADS_DIR || join(process.cwd(), 'uploads');
  app.useStaticAssets(uploadsDir, { prefix: '/uploads/' });

  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());

  app.use(
    (
      req: import('express').Request,
      _res: import('express').Response,
      next: import('express').NextFunction,
    ) => {
      const logger = new Logger('HTTP');
      logger.log(`${req.method} ${req.url}`);
      next();
    },
  );

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  new Logger('Bootstrap').log(
    `Fuel backend running on http://localhost:${port}`,
  );
}

bootstrap();
