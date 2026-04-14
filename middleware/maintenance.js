const GlobalConfig = require('../models/GlobalConfig');

const maintenanceMiddleware = async (req, res, next) => {
  try {
    // Skip maintenance check for admin routes so they can turn it off
    // and for webhooks so we don't miss payments
    if (req.path.startsWith('/api/admin') || req.path.startsWith('/api/webhooks')) {
      return next();
    }

    const config = await GlobalConfig.getConfig();
    
    if (config.maintenanceMode) {
      return res.status(503).json({
        success: false,
        maintenance: true,
        message: config.maintenanceMessage || 'System under maintenance'
      });
    }

    next();
  } catch (error) {
    console.error('Maintenance middleware error:', error);
    next(); // Continue even if check fails to avoid total lockout
  }
};

module.exports = maintenanceMiddleware;
