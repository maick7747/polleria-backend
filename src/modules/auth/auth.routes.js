'use strict';

const express = require('express');
const authMiddleware = require('../../middleware/auth');
const service = require('./auth.service');

const router = express.Router();

router.post('/login', async (req, res) => {
  res.json(await service.login(req.body));
});

router.get('/me', authMiddleware, async (req, res) => {
  res.json(await service.me(req.usuario.id));
});

router.post('/logout', authMiddleware, (req, res) => {
  res.status(204).end();
});

module.exports = router;
