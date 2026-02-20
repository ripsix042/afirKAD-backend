const express = require('express');
const { body, validationResult } = require('express-validator');
const ChatMessage = require('../models/ChatMessage');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// GET /support/chat - get chat history for the authenticated user
router.get('/chat', authenticate, async (req, res) => {
  try {
    const userId = req.user._id;
    const messages = await ChatMessage.find({ userId })
      .sort({ createdAt: 1 })
      .lean();

    const formatted = messages.map((m) => ({
      id: m._id.toString(),
      message: m.message,
      sender: m.sender,
      timestamp: m.createdAt,
    }));

    res.json({
      success: true,
      messages: formatted,
    });
  } catch (error) {
    console.error('Get chat history error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load chat history.',
      error: error.message,
    });
  }
});

// POST /support/chat - send a message (user only; support replies can be added later via admin or internal tool)
router.post('/chat', authenticate, [
  body('message').notEmpty().trim().isLength({ max: 2000 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const userId = req.user._id;
    const { message } = req.body;

    const chatMessage = new ChatMessage({
      userId,
      sender: 'user',
      message,
    });
    await chatMessage.save();

    res.status(201).json({
      success: true,
      message: 'Message sent successfully',
      chatMessage: {
        id: chatMessage._id.toString(),
        message: chatMessage.message,
        sender: chatMessage.sender,
        timestamp: chatMessage.createdAt,
      },
    });
  } catch (error) {
    console.error('Send chat message error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send message.',
      error: error.message,
    });
  }
});

module.exports = router;
