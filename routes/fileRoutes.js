import { Router } from 'express';
import {
  listFiles,
  getFileContent
} from '../controllers/fileController.js';

const router = Router();

router.get('/', listFiles);                         // GET /files
router.get('/:name/content', getFileContent);       // GET /files/:name/content

export default router;
