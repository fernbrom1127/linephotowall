// test-deepseek-models.js (修正版 - 跳過下載步驟)
const axios = require('axios');
const fs = require('fs');

const DEEPSEEK_API_KEY = process.argv[2] || process.env.DEEPSEEK_API_KEY;

if (!DEEPSEEK_API_KEY) {
  console.error('❌ 請提供 API Key');
  process.exit(1);
}

// 一個 1x1 像素的 Base64 圖片數據 (完全公開且穩定)
const FALLBACK_IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

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

async function testModel(modelName, imageBase64) {
  console.log(`\n🔍 測試模型: ${modelName}`);
  
  // 先嘗試 DeepSeek 專用的 images 格式
  let requestBody = {
    model: modelName,
    messages: [
      {
        role: 'user',
        content: '請用一個英文單字描述這張圖片的主要內容',
        images: [`data:image/png;base64,${imageBase64}`]
      }
    ],
    max_tokens: 20,
    temperature: 0.3
  };
  
  try {
    const response = await axios.post(DEEPSEEK_API_URL, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
      },
      timeout: 15000
    });
    
    const result = response.data.choices[0].message.content;
    console.log(`   ✅ 成功 (images 格式)！回應: ${result}`);
    return { model: modelName, success: true, format: 'images', result };
  } catch (error) {
    let errorMsg = error.response?.data?.error?.message || error.message;
    
    // 如果 images 格式失敗，再嘗試 OpenAI 標準格式
    console.log(`   ⚠️ images 格式失敗，嘗試 OpenAI 格式...`);
    requestBody = {
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
                url: `data:image/png;base64,${FALLBACK_IMAGE_BASE64}`
              }
            }
          ]
        }
      ],
      max_tokens: 20,
      temperature: 0.3
    };
    
    try {
      const response2 = await axios.post(DEEPSEEK_API_URL, requestBody, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        },
        timeout: 15000
      });
      
      const result2 = response2.data.choices[0].message.content;
      console.log(`   ✅ 成功 (OpenAI 格式)！回應: ${result2}`);
      return { model: modelName, success: true, format: 'openai', result: result2 };
    } catch (error2) {
      let errorMsg2 = error2.response?.data?.error?.message || error2.message;
      console.log(`   ❌ 失敗: ${errorMsg2.substring(0, 100)}`);
      return { model: modelName, success: false, format: 'both', error: errorMsg2 };
    }
  }
}

async function main() {
  console.log('🚀 開始測試 DeepSeek 圖片辨識模型\n');
  console.log(`API Key: ${DEEPSEEK_API_KEY.substring(0, 10)}...\n`);
  console.log('使用預設 1x1 像素測試圖片\n');
  
  const results = [];
  
  for (const model of MODELS_TO_TEST) {
    const result = await testModel(model, FALLBACK_IMAGE_BASE64);
    results.push(result);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
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
  }
}

main().catch(console.error);
