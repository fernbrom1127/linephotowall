// cleanup-missing-photos.js
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const axios = require('axios');

// ... (读取环境变量、认证等代码与之前脚本相同) ...

async function cleanup() {
  const auth = new JWT({ email: client_email, key: private_key, scopes: [...] });
  const doc = new GoogleSpreadsheet(sheetId, auth);
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle['照片牆'];
  const rows = await sheet.getRows();
  
  let deletedCount = 0;
  for (const row of rows) {
    const imageUrl = row.get('圖片URL');
    try {
      // 检查图片是否还存在
      await axios.head(imageUrl);
    } catch (error) {
      if (error.response?.status === 404) {
        console.log(`🗑️ 删除无效记录: ${imageUrl}`);
        await row.delete();
        deletedCount++;
      }
    }
  }
  console.log(`\n✅ 清理完成，共删除 ${deletedCount} 条无效记录。`);
}

cleanup();
