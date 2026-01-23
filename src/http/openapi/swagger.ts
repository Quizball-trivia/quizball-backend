import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { generateOpenApiDocument } from './registry.js';

const router = Router();

// Generate OpenAPI document
const openApiDocument = generateOpenApiDocument();

// Serve raw OpenAPI JSON at /openapi.json (before Swagger UI to avoid route conflict)
router.get('/openapi.json', (_req, res) => {
  res.json(openApiDocument);
});

// Serve Swagger UI at /docs
router.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument));

export const swaggerRoutes = router;
