const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// 從環境變數讀取設定
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;

class GoogleSheetsManager {
  constructor() {
    this.doc = null;
    this.sheet = null;
    this.isReady = false;
    this.initPromise = null; // 確保只初始化一次
  }

  async initialize() {
    // 如果已經初始化完成，直接返回
    if (this.isReady) return true;
    
    // 如果正在初始化，等待完成
    if (this.initPromise) return this.initPromise;
    
    // 開始初始化
    this.initPromise = this._doInitialize();
    return this.initPromise;
  }
  
  async _doInitialize() {
    try {
      // 檢查必要的環境變數
      if (!GOOGLE_SERVICE_ACCOUNT_EMAIL) {
        console.error('❌ 缺少 GOOGLE_SERVICE_ACCOUNT_EMAIL 環境變數');
        return false;
      }
      if (!GOOGLE_PRIVATE_KEY) {
        console.error('❌ 缺少 GOOGLE_PRIVATE_KEY 環境變數');
        return false;
      }
      if (!GOOGLE_SHEET_ID) {
        console.error('❌ 缺少 GOOGLE_SHEET_ID 環境變數');
        return false;
      }
      
      console.log('🔧 開始初始化 Google Sheets...');
      console.log(`📧 服務帳戶：${GOOGLE_SERVICE_ACCOUNT_EMAIL}`);
      console.log(`📊 試算表 ID：${GOOGLE_SHEET_ID}`);
      
      const auth = new JWT({
        email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: GOOGLE_PRIVATE_KEY,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });

      this.doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, auth);
      await this.doc.loadInfo();
      console.log('✅ Google Sheets loadInfo 完成');
      
      // 取得或建立工作表
      this.sheet = this.doc.sheetsByTitle['照片牆'];
      if (!this.sheet) {
        this.sheet = await this.doc.addSheet({ 
          title: '照片牆', 
          headerValues: ['時間', '使用者ID', '圖片URL', '角色', '原始訊息'] 
        });
        console.log('✅ 已建立「照片牆」工作表');
      } else {
        console.log('✅ 已找到「照片牆」工作表');
      }
      
      this.isReady = true;
      console.log('✅ Google Sheets 連線成功');
      return true;
    } catch (error) {
      console.error('❌ Google Sheets 連線失敗：', error.message);
      this.isReady = false;
      return false;
    }
  }

  async addPhoto(userId, imageUrl, role, userMessage = '') {
    // 確保已初始化
    await this.initialize();
    
    if (!this.isReady || !this.sheet) {
      console.log('⚠️ Google Sheets 未就緒，無法儲存圖片');
      return false;
    }
    
    try {
      await this.sheet.addRow({
        '時間': new Date().toISOString(),
        '使用者ID': userId,
        '圖片URL': imageUrl,
        '角色': role,
        '原始訊息': userMessage || ''
      });
      console.log(`📸 照片已儲存到 Google Sheets - 使用者：${userId}`);
      return true;
    } catch (error) {
      console.error('❌ 儲存照片到 Google Sheets 失敗：', error.message);
      return false;
    }
  }

  async getAllPhotos(limit = 100) {
    // 確保已初始化
    await this.initialize();
    
    if (!this.isReady || !this.sheet) {
      console.log('⚠️ Google Sheets 未就緒，無法讀取照片');
      return [];
    }
    
    try {
      const rows = await this.sheet.getRows();
      const photos = rows.map(row => ({
        time: row['時間'],
        userId: row['使用者ID'],
        imageUrl: row['圖片URL'],
        role: row['角色'],
        message: row['原始訊息']
      })).reverse(); // 最新的在前面
      
      console.log(`📸 讀取到 ${photos.length} 張照片`);
      return photos.slice(0, limit);
    } catch (error) {
      console.error('❌ 讀取照片失敗：', error.message);
      return [];
    }
  }
}

module.exports = GoogleSheetsManager;
