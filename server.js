// server.js
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const OpenAI = require('openai');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
app.use(express.json());

// Configuration
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'ai_tools_db';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const AUTO_PROCESS = process.env.AUTO_PROCESS !== 'false'; // Default: true

// Initialize DeepSeek (using OpenAI SDK with custom base URL)
const deepseek = new OpenAI({
  apiKey: DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com',
});

// MongoDB connection
let db;

async function connectToMongo() {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(DB_NAME);
    console.log('Connected to MongoDB');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
}

// Function to get AI analysis from DeepSeek
async function getAIAnalysis(toolName, appUrl) {
  try {
    const prompt = `
    Analyze this AI tool and provide detailed information:
    
    Tool Name: ${toolName}
    App URL: ${appUrl}
    
    Please provide a JSON response with the following structure:
    {
      "app_description": "A comprehensive description of what this AI tool does and its main purpose",
      "app_core_features": [
        "List of key features this tool offers",
        "Each feature should be concise but descriptive"
      ],
      "app_pros": [
        "List of advantages and benefits of using this tool",
        "Focus on what makes it valuable to users"
      ],
      "app_cons": [
        "List of potential drawbacks or limitations",
        "Be fair and balanced in assessment"
      ]
    }
    
    Make sure the response is valid JSON format.
    `;

    const response = await deepseek.chat.completions.create({
      model: "deepseek-chat",
      messages: [
        {
          role: "user",
          content: prompt
        }
      ],
      max_tokens: 1000,
      temperature: 0.7
    });

    const content = response.choices[0].message.content;
    
    // Try to parse JSON response
    try {
      return JSON.parse(content);
    } catch (parseError) {
      console.error('Failed to parse DeepSeek response as JSON:', parseError);
      // Return a fallback structure if JSON parsing fails
      return {
        app_description: content.substring(0, 500) + '...',
        app_core_features: ['Feature analysis pending'],
        app_pros: ['Analysis pending'],
        app_cons: ['Analysis pending']
      };
    }
  } catch (error) {
    console.error('DeepSeek API error:', error);
    throw error;
  }
}

// Function to process a single raw data item
async function processRawDataItem(item) {
  try {
    console.log(`Processing item: ${item.ai_tool_name}`);
    
    // Get AI analysis from DeepSeek
    const aiAnalysis = await getAIAnalysis(item.ai_tool_name, item.app_url);
    
    // Prepare processed data
    const processedData = {
      ai_tool_name: item.ai_tool_name,
      app_url: item.app_url,
      logo_url: item.logo_url,
      app_description: aiAnalysis.app_description,
      app_core_features: aiAnalysis.app_core_features,
      app_pros: aiAnalysis.app_pros,
      app_cons: aiAnalysis.app_cons,
      status: 10,
      processed_at: new Date(),
      original_id: item._id
    };
    
    // Insert into processed-data collection
    const processedCollection = db.collection('Processed-test-data');
    const insertResult = await processedCollection.insertOne(processedData);
    
    // Update status in raw-data collection
    const rawCollection = db.collection('Raw-test-data');
    await rawCollection.updateOne(
      { _id: item._id },
      { 
        $set: { 
          status: 1,
          processed_at: new Date()
        }
      }
    );
    
    console.log(`Successfully processed: ${item.ai_tool_name}`);
    return {
      success: true,
      processedId: insertResult.insertedId,
      originalId: item._id
    };
    
  } catch (error) {
    console.error(`Error processing item ${item.ai_tool_name}:`, error);
    
    // Update status to indicate error (status = -1)
    const rawCollection = db.collection('Raw-test-data');
    await rawCollection.updateOne(
      { _id: item._id },
      { 
        $set: { 
          status: -1,
          error_message: error.message,
          error_at: new Date()
        }
      }
    );
    
    return {
      success: false,
      error: error.message,
      originalId: item._id
    };
  }
}

// Route to process all pending raw data
app.post('/process-raw-data', async (req, res) => {
  try {
    const rawCollection = db.collection('Raw-test-data');
    
    // Find all items with status = 0
    const pendingItems = await rawCollection.find({ status: 0 }).toArray();
    
    if (pendingItems.length === 0) {
      return res.json({
        success: true,
        message: 'No pending items to process',
        processed: 0
      });
    }
    
    console.log(`Found ${pendingItems.length} items to process`);
    
    const results = [];
    
    // Process items one by one to avoid rate limiting
    for (const item of pendingItems) {
      const result = await processRawDataItem(item);
      results.push(result);
      
      // Add delay to respect DeepSeek rate limits
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    
    res.json({
      success: true,
      message: `Processing completed. Success: ${successful}, Failed: ${failed}`,
      processed: successful,
      failed: failed,
      results: results
    });
    
  } catch (error) {
    console.error('Error in process-raw-data:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Route to process a specific item by ID
app.post('/process-item/:id', async (req, res) => {
  try {
    const itemId = req.params.id;
    const rawCollection = db.collection('Raw-test-data');
    
    const item = await rawCollection.findOne({ 
      _id: new ObjectId(itemId),
      status: 0 
    });
    
    if (!item) {
      return res.status(404).json({
        success: false,
        error: 'Item not found or already processed'
      });
    }
    
    const result = await processRawDataItem(item);
    
    if (result.success) {
      res.json({
        success: true,
        message: 'Item processed successfully',
        processedId: result.processedId
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error
      });
    }
    
  } catch (error) {
    console.error('Error in process-item:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Route to get processing status
app.get('/status', async (req, res) => {
  try {
    const rawCollection = db.collection('Raw-test-data');
    const processedCollection = db.collection('Processed-test-data');
    
    const pending = await rawCollection.countDocuments({ status: 0 });
    const processed = await rawCollection.countDocuments({ status: 1 });
    const errors = await rawCollection.countDocuments({ status: -1 });
    const totalProcessed = await processedCollection.countDocuments();
    
    res.json({
      success: true,
      status: {
        pending: pending,
        processed: processed,
        errors: errors,
        total_in_processed_collection: totalProcessed
      }
    });
    
  } catch (error) {
    console.error('Error getting status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Route to get processed data
app.get('/processed-data', async (req, res) => {
  try {
    const processedCollection = db.collection('Processed-test-data');
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    
    const data = await processedCollection
      .find({})
      .sort({ processed_at: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();
    
    const total = await processedCollection.countDocuments();
    
    res.json({
      success: true,
      data: data,
      pagination: {
        current_page: page,
        total_pages: Math.ceil(total / limit),
        total_items: total,
        items_per_page: limit
      }
    });
    
  } catch (error) {
    console.error('Error getting processed data:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Route to toggle auto-processing
app.post('/toggle-auto-process', (req, res) => {
  const { enabled } = req.body;
  
  if (enabled !== undefined) {
    process.env.AUTO_PROCESS = enabled ? 'true' : 'false';
    res.json({
      success: true,
      message: `Auto-processing ${enabled ? 'enabled' : 'disabled'}`,
      auto_process_enabled: enabled
    });
  } else {
    res.json({
      success: true,
      auto_process_enabled: process.env.AUTO_PROCESS !== 'false'
    });
  }
});

// Health check route
app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
});

// Function to auto-process pending data
async function autoProcessPendingData() {
  try {
    console.log('🔍 Checking for pending data to process...');
    
    const rawCollection = db.collection('Raw-test-data');
    const pendingCount = await rawCollection.countDocuments({ status: 0 });
    
    if (pendingCount === 0) {
      console.log('✅ No pending items found');
      return;
    }
    
    console.log(`🚀 Found ${pendingCount} pending items. Starting auto-processing...`);
    
    const pendingItems = await rawCollection.find({ status: 0 }).toArray();
    let processed = 0;
    let failed = 0;
    
    for (const item of pendingItems) {
      const result = await processRawDataItem(item);
      if (result.success) {
        processed++;
        console.log(`✅ Processed: ${item.ai_tool_name} (${processed}/${pendingCount})`);
      } else {
        failed++;
        console.log(`❌ Failed: ${item.ai_tool_name} - ${result.error}`);
      }
      
      // Add delay to respect DeepSeek rate limits
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    console.log(`🎉 Auto-processing completed! Success: ${processed}, Failed: ${failed}`);
    
  } catch (error) {
    console.error('❌ Auto-processing error:', error);
  }
}

// Start server
async function startServer() {
  await connectToMongo();
  
  app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Process data: POST http://localhost:${PORT}/process-raw-data`);
    console.log(`Check status: GET http://localhost:${PORT}/status`);
    
    // Auto-process pending data on startup (if enabled)
    if (AUTO_PROCESS) {
      setTimeout(() => {
        autoProcessPendingData();
      }, 2000);
      
      // Schedule automatic processing every 2 hours
      cron.schedule('0 */2 * * *', () => {
        if (process.env.AUTO_PROCESS !== 'false') {
          console.log('⏰ Scheduled processing triggered...');
          autoProcessPendingData();
        }
      });
      
      console.log('⏰ Auto-processing enabled: On startup + Every 2 hours');
    } else {
      console.log('⏸️  Auto-processing disabled. Use POST /process-raw-data to process manually');
    }
  });
}

startServer().catch(console.error);