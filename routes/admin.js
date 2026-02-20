const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// All admin routes require authentication and admin role
router.use(authenticate);
router.use(requireAdmin);

// Dashboard overview
router.get('/dashboard', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const dateFilter = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {};
      if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
      if (endDate) dateFilter.createdAt.$lte = new Date(endDate);
    }

    // Total users
    const totalUsers = await User.countDocuments();

    // Total balances
    const balanceResult = await User.aggregate([
      {
        $group: {
          _id: null,
          totalNgn: { $sum: '$wallet.ngn' },
          totalUsd: { $sum: '$wallet.usd' },
          totalLockedNgn: { $sum: '$wallet.lockedNgn' },
        },
      },
    ]);

    const totalBalances = balanceResult[0] || {
      totalNgn: 0,
      totalUsd: 0,
      totalLockedNgn: 0,
    };

    // Transaction statistics
    const transactionStats = await Transaction.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: null,
          totalTransactions: { $sum: 1 },
          totalNgnVolume: {
            $sum: {
              $cond: [{ $eq: ['$currency', 'NGN'] }, '$amount', 0],
            },
          },
          totalUsdVolume: {
            $sum: {
              $cond: [{ $eq: ['$currency', 'USD'] }, '$amountConverted', 0],
            },
          },
          completed: {
            $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] },
          },
          failed: {
            $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] },
          },
          processing: {
            $sum: { $cond: [{ $eq: ['$status', 'processing'] }, 1, 0] },
          },
        },
      },
    ]);

    const stats = transactionStats[0] || {
      totalTransactions: 0,
      totalNgnVolume: 0,
      totalUsdVolume: 0,
      completed: 0,
      failed: 0,
      processing: 0,
    };

    res.json({
      success: true,
      dashboard: {
        users: {
          total: totalUsers,
        },
        balances: {
          ngn: totalBalances.totalNgn,
          usd: totalBalances.totalUsd,
          lockedNgn: totalBalances.totalLockedNgn,
        },
        transactions: stats,
      },
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch dashboard data.',
    });
  }
});

// Transaction volume over time (for charts)
router.get('/charts/volume', async (req, res) => {
  try {
    const { period = 'day', startDate, endDate } = req.query;
    
    const dateFilter = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {};
      if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
      if (endDate) dateFilter.createdAt.$lte = new Date(endDate);
    }

    let groupFormat;
    switch (period) {
      case 'hour':
        groupFormat = { year: { $year: '$createdAt' }, month: { $month: '$createdAt' }, day: { $dayOfMonth: '$createdAt' }, hour: { $hour: '$createdAt' } };
        break;
      case 'week':
        groupFormat = { year: { $year: '$createdAt' }, week: { $week: '$createdAt' } };
        break;
      case 'month':
        groupFormat = { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } };
        break;
      default:
        groupFormat = { year: { $year: '$createdAt' }, month: { $month: '$createdAt' }, day: { $dayOfMonth: '$createdAt' } };
    }

    const ngnVolume = await Transaction.aggregate([
      { $match: { ...dateFilter, currency: 'NGN', status: 'completed' } },
      {
        $group: {
          _id: groupFormat,
          volume: { $sum: '$amount' },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1, '_id.hour': 1, '_id.week': 1 } },
    ]);

    const usdVolume = await Transaction.aggregate([
      { $match: { ...dateFilter, convertedCurrency: 'USD', status: 'completed' } },
      {
        $group: {
          _id: groupFormat,
          volume: { $sum: '$amountConverted' },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1, '_id.hour': 1, '_id.week': 1 } },
    ]);

    res.json({
      success: true,
      ngnVolume,
      usdVolume,
    });
  } catch (error) {
    console.error('Charts volume error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch volume data.',
    });
  }
});

// Transaction status breakdown (for charts)
router.get('/charts/status', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const dateFilter = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {};
      if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
      if (endDate) dateFilter.createdAt.$lte = new Date(endDate);
    }

    const statusBreakdown = await Transaction.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
        },
      },
    ]);

    res.json({
      success: true,
      statusBreakdown,
    });
  } catch (error) {
    console.error('Charts status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch status data.',
    });
  }
});

// Wallets overview (platform balances + today's flows)
router.get('/wallets', async (req, res) => {
  try {
    const balanceResult = await User.aggregate([
      {
        $group: {
          _id: null,
          totalNgn: { $sum: '$wallet.ngn' },
          totalUsd: { $sum: '$wallet.usd' },
          totalLockedNgn: { $sum: '$wallet.lockedNgn' },
        },
      },
    ]);
    const totals = balanceResult[0] || { totalNgn: 0, totalUsd: 0, totalLockedNgn: 0 };

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);

    const todayFlows = await Transaction.aggregate([
      { $match: { createdAt: { $gte: startOfToday, $lte: endOfToday } } },
      {
        $group: {
          _id: null,
          ngnInflow: {
            $sum: { $cond: [{ $and: [{ $eq: ['$type', 'deposit'] }, { $eq: ['$currency', 'NGN'] }] }, '$amount', 0] },
          },
          usdOutflow: {
            $sum: {
              $cond: [
                { $in: ['$type', ['payment', 'card_payment']] },
                {
                  $cond: [
                    { $eq: ['$currency', 'USD'] },
                    '$amount',
                    { $cond: [{ $eq: ['$convertedCurrency', 'USD'] }, { $ifNull: ['$amountConverted', 0] }, 0] },
                  ],
                },
                0,
              ],
            },
          },
        },
      },
    ]);
    const flows = todayFlows[0] || { ngnInflow: 0, usdOutflow: 0 };

    res.json({
      success: true,
      wallets: {
        totalNgn: totals.totalNgn,
        totalUsd: totals.totalUsd,
        lockedNgn: totals.totalLockedNgn,
        todayNgnInflow: flows.ngnInflow,
        todayUsdOutflow: flows.usdOutflow,
      },
    });
  } catch (error) {
    console.error('Wallets error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch wallets data.' });
  }
});

// Cards (users with virtual card) - paginated
router.get('/cards', async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const query = { koraVirtualCardId: { $exists: true, $nin: [null, ''] } };
    const cards = await User.find(query)
      .select('email firstName lastName koraVirtualCardId createdAt')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    const total = await User.countDocuments(query);

    res.json({
      success: true,
      cards: cards.map((u) => ({
        userId: u._id,
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        cardId: u.koraVirtualCardId,
        createdAt: u.createdAt,
      })),
      pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (error) {
    console.error('Cards error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch cards.' });
  }
});

// Admin health (DB status)
router.get('/health', async (req, res) => {
  try {
    const database = mongoose.connection.readyState === 1 ? 'ok' : 'down';
    res.json({ success: true, database });
  } catch (error) {
    res.json({ success: false, database: 'down' });
  }
});

// Get single user
router.get('/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId).select('-password').lean();
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    res.json({ success: true, user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch user.' });
  }
});

// Get all users
router.get('/users', async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const users = await User.find()
      .select('-password')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    const total = await User.countDocuments();

    res.json({
      success: true,
      users,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch users.',
    });
  }
});

// Export transactions as CSV (must be before /transactions/:id)
router.get('/transactions/export', async (req, res) => {
  try {
    const { type, status, userId, startDate, endDate, limit = 10000 } = req.query;
    const query = {};
    if (type) query.type = type;
    if (status) query.status = status;
    if (userId) query.userId = userId;
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const transactions = await Transaction.find(query)
      .populate('userId', 'email firstName lastName')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .lean();

    const headers = ['id', 'userId', 'user', 'type', 'status', 'amount', 'currency', 'merchantName', 'createdAt'];
    const escape = (v) => (v == null ? '' : String(v).replace(/"/g, '""'));
    const row = (t) =>
      headers
        .map((h) => {
          if (h === 'user') return `"${escape(t.userId ? [t.userId.firstName, t.userId.lastName].filter(Boolean).join(' ') : '')}"`;
          if (h === 'id') return `"${escape(t._id && t._id.toString())}"`;
          if (h === 'userId') return `"${escape(t.userId && t.userId._id && t.userId._id.toString())}"`;
          return `"${escape(t[h])}"`;
        })
        .join(',');

    const csv = [headers.join(','), ...transactions.map(row)].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=transactions.csv');
    res.send(csv);
  } catch (error) {
    console.error('Export transactions error:', error);
    res.status(500).json({ success: false, message: 'Failed to export transactions.' });
  }
});

// Get single transaction
router.get('/transactions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const transaction = await Transaction.findById(id).populate('userId', 'email firstName lastName').lean();
    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found.' });
    }
    res.json({ success: true, transaction });
  } catch (error) {
    console.error('Get transaction error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch transaction.' });
  }
});

// Get all transactions
router.get('/transactions', async (req, res) => {
  try {
    const { page = 1, limit = 50, type, status, userId } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const query = {};
    if (type) query.type = type;
    if (status) query.status = status;
    if (userId) query.userId = userId;

    const transactions = await Transaction.find(query)
      .populate('userId', 'email firstName lastName')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    const total = await Transaction.countDocuments(query);

    res.json({
      success: true,
      transactions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch transactions.',
    });
  }
});

// Disputes endpoint (placeholder - can be enhanced with a Dispute model later)
router.get('/disputes', async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // For now, return empty array. Can be enhanced with a Dispute model
    res.json({
      success: true,
      disputes: [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: 0,
        pages: 0,
      },
    });
  } catch (error) {
    console.error('Get disputes error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch disputes.',
    });
  }
});

// KYC/Compliance endpoint
router.get('/kyc', async (req, res) => {
  try {
    const { page = 1, limit = 20, status, level } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // For now, return empty array. Can be enhanced with a KYC model later
    res.json({
      success: true,
      kyc: [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: 0,
        pages: 0,
      },
    });
  } catch (error) {
    console.error('Get KYC error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch KYC data.',
    });
  }
});

module.exports = router;
