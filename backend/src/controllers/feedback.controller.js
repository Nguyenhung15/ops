const { feedbackService } = require('../services/feedback.service');

class FeedbackController {
  /**
   * POST /feedbacks - Patient gửi phản hồi mới
   */
  async createFeedback(req, res, next) {
    try {
      const result = await feedbackService.createFeedback(req.user, req.body, req);
      return res.status(201).json({
        ok: true,
        success: true,
        message: 'Gửi đánh giá phản hồi thành công',
        data: result,
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * GET /feedbacks/my - Patient xem danh sách phản hồi của chính mình
   */
  async getMyFeedbacks(req, res, next) {
    try {
      const result = await feedbackService.getMyFeedbacks(req.user, req.query);
      return res.status(200).json({
        ok: true,
        success: true,
        message: 'Lấy danh sách phản hồi thành công',
        data: result.items,
        pagination: result.pagination,
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * PUT /feedbacks/:id - Patient cập nhật phản hồi
   */
  async updateFeedback(req, res, next) {
    try {
      const result = await feedbackService.updateFeedback(req.user, req.params.id, req.body, req);
      return res.status(200).json({
        ok: true,
        success: true,
        message: 'Cập nhật phản hồi thành công',
        data: result,
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * DELETE /feedbacks/:id - Patient xóa mềm phản hồi
   */
  async deleteFeedback(req, res, next) {
    try {
      const result = await feedbackService.deleteFeedback(req.user, req.params.id, req);
      return res.status(200).json({
        ok: true,
        success: true,
        message: 'Xóa phản hồi thành công',
        data: result,
      });
    } catch (error) {
      return next(error);
    }
  }
}

const feedbackController = new FeedbackController();
module.exports = {
  feedbackController,
  FeedbackController,
};
