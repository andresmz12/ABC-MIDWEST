const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});
if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
  console.warn('WARNING: Cloudinary env vars not set — file uploads will fail.');
}

const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const isVideo = file.mimetype.startsWith('video/');
    // Use company_id from the authenticated request for folder isolation
    const folder = req.companyId ? `companies/${req.companyId}` : 'companies/shared';
    return {
      folder,
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
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB
});

// ── Document upload (PDF, Office, images) ─────────────────────────────────────

const docStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const folder = req.companyId ? `companies/${req.companyId}/documents` : 'companies/shared/documents';
    const isImage = file.mimetype.startsWith('image/');
    return {
      folder,
      resource_type: isImage ? 'image' : 'raw',
      public_id: `${Date.now()}-${Math.round(Math.random() * 1e6)}`
    };
  }
});

const docFileFilter = (req, file, cb) => {
  const allowed = [
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv',
  ];
  if (allowed.includes(file.mimetype)) cb(null, true);
  else cb(new Error('File type not supported. Allowed: PDF, Word, Excel, PowerPoint, images, CSV, TXT'), false);
};

const uploadDoc = multer({
  storage: docStorage,
  fileFilter: docFileFilter,
  limits: { fileSize: 25 * 1024 * 1024 }
});

module.exports = { upload, uploadDoc, cloudinary };
