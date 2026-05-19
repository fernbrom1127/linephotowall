// test-deepseek-models.js - 測試 DeepSeek API 哪個模型支援圖片辨識
const axios = require('axios');
const fs = require('fs');

// 從命令列參數或環境變數讀取 API Key
const DEEPSEEK_API_KEY = process.argv[2] || process.env.DEEPSEEK_API_KEY;

if (!DEEPSEEK_API_KEY) {
  console.error('❌ 請提供 API Key');
  console.error('用法: node test-deepseek-models.js YOUR_API_KEY');
  process.exit(1);
}

// 測試用圖片 URL（一隻貓咪的公開圖片）
const TEST_IMAGE_URL = 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4d/Cat_November_2010-1a.jpg/800px-Cat_November_2010-1a.jpg';

// 要測試的模型列表（按可能性排序）
const MODELS_TO_TEST = [
  'deepseek-chat',
  'deepseek-vl',
  'deepseek-vl2', 
  'deepseek-vision',
  'deepseek-v4-flash',
  'deepseek-v3',
  'deepseek-vl-chat',
  'deepseek-multi-modal'
];

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

// 下載圖片並轉為 base64
async function downloadImageAsBase64(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 15000
  });
  return Buffer.from(response.data).toString('base64');
}

// 測試單一模型（使用 images 參數格式）
async function testModelWithImages(modelName, imageBase64) {
  console.log(`\n🔍 測試模型: ${modelName} (使用 images 格式)`);
  
  const requestBody = {
    model: modelName,
    messages: [
      {
        role: 'user',
        content: '請用一個英文單字描述這張圖片的主要內容',
        images: [`data:image/jpeg;base64,${imageBase64}`]
      }
    ],
    max_tokens: 50,
    temperature: 0.3
  };
  
  try {
    const response = await axios.post(DEEPSEEK_API_URL, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
      },
      timeout: 30000
    });
    
    const result = response.data.choices[0].message.content;
    console.log(`   ✅ 成功！回應: ${result}`);
    return { model: modelName, format: 'images', success: true, result };
  } catch (error) {
    const errorMsg = error.response?.data?.error?.message || error.message;
    console.log(`   ❌ 失敗: ${errorMsg.substring(0, 100)}`);
    return { model: modelName, format: 'images', success: false, error: errorMsg };
  }
}

// 測試標準 OpenAI 格式（對比用）
async function testModelWithOpenAIFormat(modelName, imageBase64) {
  console.log(`\n🔍 測試模型: ${modelName} (使用 OpenAI 格式)`);
  
  const requestBody = {
    model: modelName,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '請用一個英文單字描述這張圖片'
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/jpeg;base64,${imageBase64}`
            }
          }
        ]
      }
    ],
    max_tokens: 50,
    temperature: 0.3
  };
  
  try {
    const response = await axios.post(DEEPSEEK_API_URL, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
      },
      timeout: 30000
    });
    
    const result = response.data.choices[0].message.content;
    console.log(`   ✅ 成功！回應: ${result}`);
    return { model: modelName, format: 'openai', success: true, result };
  } catch (error) {
    const errorMsg = error.response?.data?.error?.message || error.message;
    console.log(`   ❌ 失敗: ${errorMsg.substring(0, 100)}`);
    return { model: modelName, format: 'openai', success: false, error: errorMsg };
  }
}

// 主程式
async function main() {
  console.log('🚀 開始測試 DeepSeek 圖片辨識模型\n');
  console.log(`API Key: ${DEEPSEEK_API_KEY.substring(0, 10)}...\n`);
  console.log('📥 下載測試圖片...');
  
  let imageBase64;
  try {
    imageBase64 = await downloadImageAsBase64(TEST_IMAGE_URL);
    console.log('✅ 圖片下載完成\n');
  } catch (error) {
    console.error('❌ 圖片下載失敗:', error.message);
    process.exit(1);
  }
  
  const results = [];
  
  // 測試所有模型
  for (const model of MODELS_TO_TEST) {
    // 先測試 images 格式
    const result1 = await testModelWithImages(model, imageBase64);
    results.push(result1);
    
    // 如果 images 格式失敗，再試 OpenAI 格式
    if (!result1.success) {
      const result2 = await testModelWithOpenAIFormat(model, imageBase64);
      results.push(result2);
    }
    
    // 避免請求太快
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  // 輸出總結
  console.log('\n' + '='.repeat(60));
  console.log('📊 測試結果總結');
  console.log('='.repeat(60));
  
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  
  if (successful.length > 0) {
    console.log('\n✅ 可用的模型:');
    for (const r of successful) {
      console.log(`   - ${r.model} (使用 ${r.format} 格式)`);
    }
  } else {
    console.log('\n❌ 沒有找到可用的視覺模型');
    console.log('\n可能原因:');
    console.log('   1. 你的 API Key 沒有視覺辨識權限');
    console.log('   2. 需要在開發者平台申請開通「多模态」功能');
    console.log('   3. 帳號類型是個人開發者，預設只有文字權限');
  }
  
  if (failed.length > 0) {
    console.log('\n⚠️ 失敗的模型:');
    for (const r of failed) {
      console.log(`   - ${r.model} (${r.format} 格式): ${r.error?.substring(0, 80)}`);
    }
  }
}

main().catch(console.error);
