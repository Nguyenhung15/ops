const { Router } = require('express');
const receptionistController = require('../controllers/receptionist.controller');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { ROLES } = require('../constants/enums');

const router = Router();

router.use(authenticate, authorize(ROLES.ADMIN));

router.get('/all', receptionistController.getAllReceptionists);
router.get('/:id', receptionistController.getReceptionistById);
router.put('/update/:id', receptionistController.updateReceptionist);
router.delete('/:id', receptionistController.deleteReceptionist);

module.exports = router;

