import { Router } from 'express';
import { startChat, chatWithFiles } from '../controllers/chatController.js';

const router = Router();

router.post('/start', startChat); // ← NUEVO
router.post('/',       chatWithFiles);

export default router;
