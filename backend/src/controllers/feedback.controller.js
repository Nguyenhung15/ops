const feedbackService = require('../services/feedback.service');
const { sendSuccess } = require('../utils/response');

const getPublicFeedbacks = async (req, res, next) => {
  try {
    const feedbacks = await feedbackService.getPublicFeedbacks(req.query, req.user);
    return sendSuccess(res, { data: feedbacks });
  } catch (err) {
    return next(err);
  }
};

const getFeedbackStats = async (_req, res, next) => {
  try {
    const stats = await feedbackService.getFeedbackStats();
    return sendSuccess(res, { data: stats });
  } catch (err) {
    return next(err);
  }
};

const getMyFeedbacks = async (req, res, next) => {
  try {
    const result = await feedbackService.getMyFeedbacks(req.user, req.query);
    if (result && Array.isArray(result.items)) {
      return res.status(200).json({
        ok: true,
        success: true,
        message: 'Lấy danh sách phản hồi thành công',
        data: result.items,
        pagination: result.pagination,
      });
    }
    return sendSuccess(res, { data: result });
  } catch (err) {
    return next(err);
  }
};

const createFeedback = async (req, res, next) => {
  try {
    const result = await feedbackService.createFeedback(req.user, req.body, req);
    return res.status(201).json({
      ok: true,
      success: true,
      message: 'Gửi đánh giá thành công',
      data: result,
    });
  } catch (err) {
    return next(err);
  }
};

const updateFeedback = async (req, res, next) => {
  try {
    const result = await feedbackService.updateFeedback(req.user, req.params.id, req.body, req);
    return res.status(200).json({
      ok: true,
      success: true,
      message: 'Cập nhật đánh giá thành công',
      data: result,
    });
  } catch (err) {
    return next(err);
  }
};

const deleteFeedback = async (req, res, next) => {
  try {
    const result = await feedbackService.deleteFeedback(req.user, req.params.id, req);
    return res.status(200).json({
      ok: true,
      success: true,
      message: result?.message || 'Xóa đánh giá thành công',
      data: result,
    });
  } catch (err) {
    return next(err);
  }
};

// =========================================================================
// UC-ADM-11: Admin/Moderator Handlers
// =========================================================================

const getAllFeedbacksForAdmin = async (req, res, next) => {
  try {
    const feedbacks = await feedbackService.getAllFeedbacksForAdmin(req.query);
    return sendSuccess(res, { data: feedbacks });
  } catch (err) {
    return next(err);
  }
};

const getFeedbackDetailForAdmin = async (req, res, next) => {
  try {
    const feedback = await feedbackService.getFeedbackDetailForAdmin(req.params.id);
    return sendSuccess(res, { data: feedback });
  } catch (err) {
    return next(err);
  }
};

const respondToFeedback = async (req, res, next) => {
  try {
    const feedback = await feedbackService.respondToFeedback(req.user, req.params.id, req.body, req);
    return sendSuccess(res, {
      message: 'Phản hồi đánh giá thành công',
      data: feedback,
    });
  } catch (err) {
    return next(err);
  }
};

const changeFeedbackStatus = async (req, res, next) => {
  try {
    const feedback = await feedbackService.changeFeedbackStatus(req.user, req.params.id, req.body, req);
    return sendSuccess(res, {
      message: 'Cập nhật trạng thái kiểm duyệt thành công',
      data: feedback,
    });
  } catch (err) {
    return next(err);
  }
};

const controller = {
  getPublicFeedbacks,
  getFeedbackStats,
  getMyFeedbacks,
  createFeedback,
  updateFeedback,
  deleteFeedback,
  getAllFeedbacksForAdmin,
  getFeedbackDetailForAdmin,
  respondToFeedback,
  changeFeedbackStatus,
};
controller.feedbackController = controller;

module.exports = controller;
