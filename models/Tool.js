const mongoose = require('mongoose');

const featureSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  }
});

const prosConsSchema = new mongoose.Schema({
  pros: [{
    type: String
  }],
  cons: [{
    type: String
  }]
});

const toolSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    index: true
  },
  slug: {
    type: String,
    required: true,
    unique: true
  },
  website: {
    type: String,
    required: true
  },
  tagline: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  company: {
    type: String,
    required: true
  },
  longDescription: {
    type: String,
    required: true
  },
  categories: [{
    type: String,
    required: true
  }],
  features: [featureSchema],
  integrations: [{
    type: String
  }],
  prosCons: prosConsSchema,
  useCases: [{
    type: String
  }],
  logo_url: {
    type: String
  },
  status: {
    type: Number,
    default: 10,
    index: true
  },
  processed_at: {
    type: Date,
    default: Date.now
  },
  original_id: {
    type: String
  }
}, {
  timestamps: true,
  collection: 'Processed-test-data'
});

// Create indexes for better query performance
toolSchema.index({ categories: 1 });

const Tool = mongoose.model('Tool', toolSchema);
module.exports = Tool; 