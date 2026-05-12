import { Router } from 'express';

const router = Router();

router.get('/me', (req, res) => {
  const { id, email, role } = req.user;
  res.json({ id, email, role });
});

export default router;
