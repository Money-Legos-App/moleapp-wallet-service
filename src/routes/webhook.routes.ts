import { Router } from 'express';
import { webhookController } from '../controllers/webhookController.js';

const router = Router();

// Alchemy Address Activity Webhook
// NOTE: This route receives raw body (express.raw) for HMAC signature validation
router.post('/alchemy', webhookController.handleAlchemyWebhook);

export default router;
