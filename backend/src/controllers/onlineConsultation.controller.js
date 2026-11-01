const { onlineConsultationService } = require('../services/onlineConsultation.service');

/**
 * POST /appointments/:id/join-online
 * UC-PAT-07: Bệnh nhân tham gia phòng khám online
 */
async function joinOnline(req, res, next) {
  try {
    const { id } = req.params;
    const result = await onlineConsultationService.joinOnline(req.user, id, req);

    return res.status(200).json({
      ok: true,
      message: 'Tham gia phòng khám online thành công',
      data: result,
      meetingUrl: result.meetingUrl,
      joinToken: result.joinToken,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  joinOnline,
};
