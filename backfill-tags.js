// backfill-tags.js
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const cloudinary = require('cloudinary').v2;
const axios = require('axios');

// 讀取環境變數（GitHub Actions 會自動注入）
const client_email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
let private_key = process.env.GOOGLE_PRIVATE_KEY;

// 處理私鑰格式：如果包含 \\n 就轉成真正的換行
if (private_key) {
  // 移除可能的外層雙引號
  private_key = private_key.replace(/^"|"$/g, '');
  // 將字面上的 \n 轉成真正的換行符號
  private_key = private_key.replace(/\\n/g, '\n');
}

const sheetId = process.env.GOOGLE_SHEET_ID;

console.log('🔧 檢查環境變數:');
console.log(`EMAIL: ${client_email ? '已設定' : '❌ 未設定'}`);
console.log(`PRIVATE KEY: ${private_key ? `已設定 (長度: ${private_key.length})` : '❌ 未設定'}`);
console.log(`SHEET ID: ${sheetId ? '已設定' : '❌ 未設定'}`);

async function backfillTags() {
  if (!client_email || !private_key || !sheetId) {
    console.error('❌ 缺少必要的環境變數');
    process.exit(1);
  }
  
  console.log('🔧 開始批次補回 AI 標籤...');
  
  try {
    const auth = new JWT({
      email: client_email,
      key: private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    
    const doc = new GoogleSpreadsheet(sheetId, auth);
    await doc.loadInfo();
    console.log('✅ Google Sheets 連線成功');
    
    const photosSheet = doc.sheetsByTitle['照片牆'];
    if (!photosSheet) {
      console.error('❌ 找不到「照片牆」工作表');
      return;
    }
    
    await photosSheet.loadHeaderRow();
    const rows = await photosSheet.getRows();
    console.log(`📋 總共有 ${rows.length} 筆照片`);
    
    let updatedCount = 0;
    
    // 測試模式：只處理前 2 筆
    const testMode = true;
    let processed = 0;
    
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const existingTags = row.get('標籤') || '';
      
      if (existingTags !== '') {
        console.log(`⏭️ 第 ${i+1} 筆已有標籤，跳過`);
        continue;
      }
      
      if (testMode && processed >= 2) {
        console.log('✅ 測試模式完成，已處理 2 張照片');
        break;
      }
      
      const imageUrl = row.get('圖片URL');
      if (!imageUrl) continue;
      
      console.log(`🔄 處理第 ${i+1}/${rows.length} 筆：${imageUrl.substring(0, 60)}...`);
      
      try {
        const response = await axios.get(imageUrl, { 
          responseType: 'arraybuffer',
          timeout: 30000 
        });
        
        const uploadResult = await new Promise((resolve, reject) => {
          const uploadStream = cloudinary.uploader.upload_stream(
            {
              folder: 'temp_backfill',
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
        
        const aiTags = (uploadResult.tags || []).join(', ');
        
        if (aiTags) {
          row.set('標籤', aiTags);
          await row.save();
          updatedCount++;
          processed++;
          console.log(`✅ 已更新標籤：${aiTags.substring(0, 50)}...`);
        } else {
          console.log(`⚠️ 未偵測到標籤`);
        }
        
        await cloudinary.uploader.destroy(uploadResult.public_id);
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } catch (error) {
        console.error(`❌ 處理失敗：`, error.message);
      }
    }
    
    console.log(`\n🎉 完成！共更新了 ${updatedCount} 筆照片的標籤`);
  } catch (error) {
    console.error('❌ 錯誤：', error.message);
    console.error(error);
  }
}

backfillTags();
