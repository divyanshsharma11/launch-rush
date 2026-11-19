// GET /api/games.
import express from 'express';
import { handle } from './errors.js';

export function createGamesRouter({ orders }) {
  const router = express.Router();
  router.get('/games', handle(async (req, res) => {
    res.json({ games: await orders.listGames() });
  }));
  return router;
}
