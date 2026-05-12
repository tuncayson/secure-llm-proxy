import { Router } from 'express';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

const router = Router();

router.get('/health', (req, res) => {
  res.json({ status: 'ok', version: pkg.version });
});

export default router;
