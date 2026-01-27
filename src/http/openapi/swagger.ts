import { Router, Request, Response, NextFunction } from 'express';
import swaggerUi from 'swagger-ui-express';
import { generateOpenApiDocument } from './registry.js';
import { config } from '../../core/config.js';
import { timingSafeEqual } from 'crypto';

const router = Router();

let cachedOpenApiDocument: ReturnType<typeof generateOpenApiDocument> | null = null;

const getOpenApiDocument = (): ReturnType<typeof generateOpenApiDocument> => {
  if (!cachedOpenApiDocument) {
    cachedOpenApiDocument = generateOpenApiDocument();
  }
  return cachedOpenApiDocument;
};

/**
 * Basic Auth middleware for protecting API docs.
 * Only applied when DOCS_USERNAME and DOCS_PASSWORD are set.
 * In local/dev, docs are accessible without auth if credentials aren't configured.
 */
const docsBasicAuth = (req: Request, res: Response, next: NextFunction): void => {
  // Skip auth if credentials not configured (local dev)
  if (!config.DOCS_USERNAME || !config.DOCS_PASSWORD) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="API Documentation"');
    res.status(401).send('Authentication required');
    return;
  }

  const base64Credentials = authHeader.split(' ')[1];
  if (!base64Credentials) {
    res.setHeader('WWW-Authenticate', 'Basic realm="API Documentation"');
    res.status(401).send('Authentication required');
    return;
  }

  let credentials = '';
  try {
    credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
  } catch {
    res.setHeader('WWW-Authenticate', 'Basic realm="API Documentation"');
    res.status(401).send('Invalid credentials');
    return;
  }

  if (!credentials) {
    res.setHeader('WWW-Authenticate', 'Basic realm="API Documentation"');
    res.status(401).send('Invalid credentials');
    return;
  }
  // Split on first colon only (passwords may contain colons)
  const colonIndex = credentials.indexOf(':');
  const username = colonIndex === -1 ? credentials : credentials.substring(0, colonIndex);
  const password = colonIndex === -1 ? '' : credentials.substring(colonIndex + 1);

  const expectedUsername = config.DOCS_USERNAME ?? '';
  const expectedPassword = config.DOCS_PASSWORD ?? '';
  const usernameBuf = Buffer.from(username);
  const passwordBuf = Buffer.from(password);
  const expectedUsernameBuf = Buffer.from(expectedUsername);
  const expectedPasswordBuf = Buffer.from(expectedPassword);

  const usernameMatch =
    usernameBuf.length === expectedUsernameBuf.length &&
    timingSafeEqual(usernameBuf, expectedUsernameBuf);
  const passwordMatch =
    passwordBuf.length === expectedPasswordBuf.length &&
    timingSafeEqual(passwordBuf, expectedPasswordBuf);

  if (usernameMatch && passwordMatch) {
    next();
    return;
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="API Documentation"');
  res.status(401).send('Invalid credentials');
};

// Check if docs are enabled
if (config.DOCS_ENABLED) {
  // Serve raw OpenAPI JSON at /openapi.json (protected)
  router.get('/openapi.json', docsBasicAuth, (_req, res) => {
    res.json(getOpenApiDocument());
  });

  // Serve Swagger UI at /docs (protected)
  router.use('/docs', docsBasicAuth, swaggerUi.serve, swaggerUi.setup(getOpenApiDocument()));
}

export const swaggerRoutes = router;
