const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'dmxvogxia',
  api_key:    process.env.CLOUDINARY_API_KEY    || '377228478858355',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'jQ3AratHqEA5VaIftyecPqbyYEE'
});

const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const isVideo = file.mimetype.startsWith('video/');
    return {
      folder: 'abc-midwest',
      resource_type: isVideo ? 'video' : 'image',
      public_id: `${Date.now()}-${Math.round(Math.random() * 1e6)}`
    };
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif',
                   'video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only images and videos are allowed'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB
});

module.exports = { upload, cloudinary };
