// server.js
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const OpenAI = require('openai');
const cron = require('node-cron');
const mongoose = require('mongoose');
const Tool = require('./models/Tool');
require('dotenv').config();

const app = express();
app.use(express.json());

// Configuration
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'ai_tools_db';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const AUTO_PROCESS = process.env.AUTO_PROCESS !== 'false'; // Default: true

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// MongoDB connection
let db;

async function connectToMongo() {
  try {
    await mongoose.connect(MONGODB_URI, {
      dbName: DB_NAME
    });
    console.log('Connected to MongoDB');
    
    // Initialize the db variable for raw data operations
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(DB_NAME);
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
}

// Function to get AI analysis from OpenAI
async function getAIAnalysis(toolName, appUrl) {
  try {
    // Handle undefined/null values
    const safeName = toolName || 'Unknown Tool';
    const safeUrl = appUrl || 'No URL provided';
    
    const prompt = `
    Analyze this AI tool and provide detailed information:
    
    Tool Name: ${safeName}
    App URL: ${safeUrl}
    
    IMPORTANT: Return ONLY a valid JSON object, no markdown formatting, no code blocks, no backticks.
    
    Provide a JSON response with exactly this structure:
    {
      "name": "The official name of the tool",
      "slug": "lowercase-hyphenated-name",
      "website": "The official website URL",
      "tagline": "A short, catchy one-line description",
      "description": "A brief one-sentence description",
      "company": "The company that owns/develops the tool",
      "longDescription": "A comprehensive 2-3 paragraph description of the tool's capabilities and value proposition",
      "categories": [
        "List of relevant categories this tool belongs to",
        "Each category should be specific and relevant"
      ],
      "features": [
        {
          "name": "Feature name",
          "description": "Detailed description of the feature"
        }
      ],
      "integrations": [
        "List of major integrations and platforms supported"
      ],
      "prosCons": {
        "pros": [
          "List of advantages and benefits"
        ],
        "cons": [
          "List of potential drawbacks or limitations"
        ]
      },
      "useCases": [
        "List of specific use cases and applications"
      ]
    }
    `;

    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: "You are a helpful AI that analyzes tools and returns responses in pure JSON format without any markdown formatting or code blocks."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      max_tokens: 2000,
      temperature: 0.7
    });

    let content = response.choices[0].message.content.trim();
    
    // Clean up the response by removing markdown code blocks if present
    if (content.startsWith('```json')) {
      content = content.replace(/```json\s*/, '').replace(/```\s*$/, '').trim();
    } else if (content.startsWith('```')) {
      content = content.replace(/```\s*/, '').replace(/```\s*$/, '').trim();
    }
    
    // Try to parse JSON response
    try {
      const parsed = JSON.parse(content);
      
      // Validate that required fields exist
      if (!parsed.name || !parsed.description || !Array.isArray(parsed.features) || 
          !parsed.prosCons || !Array.isArray(parsed.useCases)) {
        throw new Error('Invalid JSON structure');
      }
      
      return parsed;
    } catch (parseError) {
      console.error('Failed to parse OpenAI response as JSON:', parseError);
      console.error('Raw content:', content);
      
      // Return a fallback structure if JSON parsing fails
      return {
        name: safeName,
        slug: safeName.toLowerCase().replace(/\s+/g, '-'),
        website: safeUrl,
        tagline: `AI tool analysis for ${safeName}`,
        description: `AI tool analysis for ${safeName}. ${content.substring(0, 200)}...`,
        company: "Unknown",
        longDescription: "Analysis pending - JSON parse error",
        categories: ["AI Tools"],
        features: [],
        integrations: [],
        prosCons: {
          pros: [],
          cons: []
        },
        useCases: []
      };
    }
  } catch (error) {
    console.error('OpenAI API error:', error);
    throw error;
  }
}

// Function to process a single raw data item
async function processRawDataItem(item) {
  try {
    // Debug: Log the entire item to see what fields are available
    console.log('Raw item data:', JSON.stringify(item, null, 2));
    
    // Handle cases where item properties might be undefined/null
    const toolName = item.appName || item.ai_tool_name || item.name || item.tool_name || 'Unknown Tool';
    const appUrl = item.appUrl || item.app_url || item.url || item.website || '';
    const logoUrl = item.appLogoUrl || item.logo_url || item.logo || item.image_url || '';
    
    console.log(`Processing item: ${toolName} (ID: ${item._id})`);
    console.log(`App URL: ${appUrl}`);
    
    // Get AI analysis from OpenAI
    const aiAnalysis = await getAIAnalysis(toolName, appUrl);
    
    console.log('AI Analysis result:', aiAnalysis);
    
    // Create a new tool document using the Mongoose model
    const tool = new Tool({
      ...aiAnalysis,
      logo_url: logoUrl,
      status: 10,
      processed_at: new Date(),
      original_id: item._id.toString()
    });
    
    // Save the tool document
    const savedTool = await tool.save();
    console.log('Saved tool document:', savedTool._id);
    
    // Update status in raw-data collection
    const rawCollection = db.collection('Raw-test-data');
    const updateResult = await rawCollection.updateOne(
      { _id: item._id },
      { 
        $set: { 
          status: 1,
          processed_at: new Date()
        }
      }
    );
    
    console.log('Update result:', updateResult.modifiedCount);
    console.log(`Successfully processed: ${toolName}`);
    
    return {
      success: true,
      processedId: savedTool._id,
      originalId: item._id
    };
    
  } catch (error) {
    const toolName = item.appName || item.ai_tool_name || item.name || item.tool_name || 'Unknown Tool';
    console.error(`Error processing item ${toolName}:`, error);
    
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
      
      // Add delay to respect OpenAI rate limits (can be reduced for higher tier accounts)
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
    
    const pending = await rawCollection.countDocuments({ status: 0 });
    const processed = await rawCollection.countDocuments({ status: 1 });
    const errors = await rawCollection.countDocuments({ status: -1 });
    const totalProcessed = await Tool.countDocuments();
    
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
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    
    const [data, total] = await Promise.all([
      Tool.find()
        .sort({ processed_at: -1 })
        .skip(skip)
        .limit(limit),
      Tool.countDocuments()
    ]);
    
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
      const toolName = item.ai_tool_name || item.name || 'Unknown Tool';
      const result = await processRawDataItem(item);
      if (result.success) {
        processed++;
        console.log(`✅ Processed: ${toolName} (${processed}/${pendingCount})`);
      } else {
        failed++;
        console.log(`❌ Failed: ${toolName} - ${result.error}`);
      }
      
      // Add delay to respect OpenAI rate limits
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
  
  const server = app.listen(PORT, async () => {
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

  // Handle server errors
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Please try a different port or close the application using this port.`);
      process.exit(1);
    } else {
      console.error('Server error:', error);
    }
  });
}

// Handle process termination
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Closing server...');
  mongoose.connection.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Closing server...');
  mongoose.connection.close();
  process.exit(0);
});

startServer().catch(console.error);