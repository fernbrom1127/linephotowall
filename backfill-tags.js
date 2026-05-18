// backfill-tags.js - 批次補回舊照片的 AI 標籤
require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const cloudinary = require('cloudinary').v2;
const axios = require('axios');

// Cloudinary 設定
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Google Sheets 設定
const client_email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const private_key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const sheetId = process.env.GOOGLE_SHEET_ID;

async function backfillTags() {
  console.log('🔧 開始批次補回 AI 標籤...');
  
  // 連線 Google Sheets
  const auth = new JWT({
    email: client_email,
    key: private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const doc = new GoogleSpreadsheet(sheetId, auth);
  await doc.loadInfo();
  const photosSheet = doc.sheetsByTitle['照片牆'];
  await photosSheet.loadHeaderRow();
  
  const rows = await photosSheet.getRows();
  let updatedCount = 0;
  
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const existingTags = row.get('標籤') || '';
    
    // 跳過已經有標籤的照片
    if (existingTags !== '') {
      console.log(`⏭️ 跳過第 ${i+1}/${rows.length} 筆（已有標籤）`);
      continue;
    }
    
    const imageUrl = row.get('圖片URL');
    if (!imageUrl) continue;
    
    console.log(`🔄 處理第 ${i+1}/${rows.length} 筆：${imageUrl.substring(0, 60)}...`);
    
    try {
      // 下載舊照片（從 Cloudinary 的 URL）
      const response = await axios.get(imageUrl, { 
        responseType: 'arraybuffer',
        timeout: 30000 
      });
      
      // 重新上傳到一個暫存資料夾（不會顯示在照片牆，只為了觸發 AI）
      const uploadResult = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: 'temp_backfill',  // 暫存資料夾
            categorization: 'google_tagging',
            auto_tagging: 0.6,
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        uploadStream.end(response.data);
      });
      
      // 取得 AI 標籤
      const aiTags = (uploadResult.tags || []).join(', ');
      
      // 更新 Google Sheets 的標籤欄位
      if (aiTags) {
        row.set('標籤', aiTags);
        await row.save();
        updatedCount++;
        console.log(`✅ 已更新標籤：${aiTags.substring(0, 50)}...`);
      } else {
        console.log(`⚠️ 未偵測到標籤，保留空白`);
      }
      
      // 刪除暫存的上傳檔案（節省空間）
      await cloudinary.uploader.destroy(uploadResult.public_id);
      
      // 避免請求太快被限制，稍微等待
      await new Promise(resolve => setTimeout(resolve, 500));
      
    } catch (error) {
      console.error(`❌ 處理失敗：`, error.message);
    }
  }
  
  console.log(`\n🎉 完成！共更新了 ${updatedCount} 筆照片的標籤`);
}

backfillTags();
