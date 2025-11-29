const express = require('express');
const admin = require('firebase-admin');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

// Initialize Firebase Admin
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
      })
    });
    console.log('✅ Firebase Admin initialized successfully');
  } catch (error) {
    console.error('❌ Firebase Admin initialization error:', error);
  }
}

const db = admin.firestore();

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'PayFast Backend API is running',
    endpoints: {
      notify: '/api/payfastNotify',
      success: '/api/payfastSuccess',
      failure: '/api/payfastFailure'
    }
  });
});

// PayFast Notify Webhook
app.post('/api/payfastNotify', async (req, res) => {
  try {
    console.log('=== PayFast Notify Webhook ===');
    console.log('Timestamp:', new Date().toISOString());
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    console.log('Body:', JSON.stringify(req.body, null, 2));

    const data = req.body;

    // Extract fields (case-insensitive)
    const basketId = data.basket_id || data.BASKET_ID;
    const errorCode = data.err_code || data.ERROR_CODE || '000';
    const transactionId = data.transaction_id || data.TRANSACTION_ID;
    const validationHash = data.validation_hash || data.VALIDATION_HASH;

    console.log('📦 Extracted Data:');
    console.log('  - Basket ID:', basketId);
    console.log('  - Error Code:', errorCode);
    console.log('  - Transaction ID:', transactionId);
    console.log('  - Validation Hash:', validationHash);

    if (!basketId || !validationHash) {
      console.error('❌ Missing required fields');
      return res.status(400).json({ 
        error: 'Missing required fields',
        received: { basketId, validationHash }
      });
    }

    // Validate hash
    const securedKey = process.env.PAYFAST_SECURED_KEY;
    const merchantId = process.env.PAYFAST_MERCHANT_ID;
    
    if (!securedKey || !merchantId) {
      console.error('❌ Missing environment variables');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    const validationString = `${basketId}|${securedKey}|${merchantId}|${errorCode}`;
    const calculatedHash = crypto
      .createHash('sha256')
      .update(validationString)
      .digest('hex');

    console.log('🔐 Hash Validation:');
    console.log('  - Validation String:', validationString);
    console.log('  - Calculated Hash:', calculatedHash);
    console.log('  - Received Hash:', validationHash);

    const isValid = calculatedHash.toLowerCase() === validationHash?.toLowerCase();

    if (!isValid) {
      console.error('❌ Hash validation failed');
      return res.status(400).json({ 
        error: 'Invalid signature',
        calculated: calculatedHash,
        received: validationHash
      });
    }

    console.log('✅ Hash validation successful');

    // Check payment status
    if (errorCode === '000' || errorCode === '00') {
      console.log('💰 Payment successful, updating Firestore...');

      // Extract challan number from basket ID
      // Format: CHALLAN-{challan_number}-{timestamp}
      // Example: CHALLAN-CH-20251124-19981-1764448963246
      const parts = basketId.split('-');
      
      // Remove "CHALLAN" (first element) and timestamp (last element)
      // This handles challan numbers with hyphens like "CH-20251124-19981"
      const challanNumber = parts.slice(1, -1).join('-');

      console.log('📄 Basket ID Parts:', parts);
      console.log('📄 Extracted Challan Number:', challanNumber);

      if (!challanNumber || challanNumber.length === 0) {
        console.error('❌ Could not extract challan number from basket ID:', basketId);
        return res.status(400).json({ 
          error: 'Invalid basket ID format',
          basketId: basketId 
        });
      }

      // Find and update challan in Firestore
      const challansRef = db.collection('challans');
      
      console.log('🔍 Searching for challan with number:', challanNumber);
      
      const snapshot = await challansRef
        .where('challanNumber', '==', challanNumber)
        .limit(1)
        .get();

      // Also try searching with challan_no field (alternative field name)
      if (snapshot.empty) {
        console.log('⚠️ Not found with "challanNumber", trying "challan_no"...');
        const snapshot2 = await challansRef
          .where('challan_no', '==', challanNumber)
          .limit(1)
          .get();
        
        if (!snapshot2.empty) {
          const challanDoc = snapshot2.docs[0];
          console.log('📍 Found challan document with challan_no:', challanDoc.id);
          
          await challanDoc.ref.update({
            status: 'PAID',
            transactionId: transactionId || 'N/A',
            basketId: basketId,
            paymentDate: admin.firestore.FieldValue.serverTimestamp(),
            paymentMethod: 'PayFast',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });

          console.log('✅ Challan updated successfully in Firestore');
          
          return res.status(200).json({ 
            success: true,
            message: 'Payment processed successfully',
            challanNumber: challanNumber,
            transactionId: transactionId
          });
        }
      }

      if (snapshot.empty) {
        console.error('❌ Challan not found in Firestore');
        console.error('   Searched for challanNumber:', challanNumber);
        console.error('   Basket ID was:', basketId);
        
        return res.status(404).json({ 
          error: 'Challan not found',
          challanNumber: challanNumber,
          basketId: basketId
        });
      }

      const challanDoc = snapshot.docs[0];
      console.log('📍 Found challan document:', challanDoc.id);
      console.log('📋 Current data:', challanDoc.data());

      await challanDoc.ref.update({
        status: 'PAID',
        transactionId: transactionId || 'N/A',
        basketId: basketId,
        paymentDate: admin.firestore.FieldValue.serverTimestamp(),
        paymentMethod: 'PayFast',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      console.log('✅ Challan updated successfully in Firestore');

      return res.status(200).json({ 
        success: true,
        message: 'Payment processed successfully',
        challanNumber: challanNumber,
        transactionId: transactionId
      });

    } else {
      console.log('❌ Payment failed with error code:', errorCode);
      return res.status(200).json({ 
        success: false,
        message: 'Payment failed',
        errorCode: errorCode
      });
    }

  } catch (error) {
    console.error('❌ Error processing webhook:', error);
    console.error('Stack trace:', error.stack);
    
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message
    });
  }
});

// PayFast Success Redirect
app.get('/api/payfastSuccess', (req, res) => {
  console.log('=== PayFast Success Redirect ===');
  console.log('Timestamp:', new Date().toISOString());
  console.log('Query params:', req.query);

  const basketId = req.query.basket_id || req.query.BASKET_ID || '';
  const transactionId = req.query.transaction_id || req.query.TRANSACTION_ID || '';

  const deepLink = `echallan://payment/success?` +
    `basket_id=${encodeURIComponent(basketId)}&` +
    `transaction_id=${encodeURIComponent(transactionId)}`;

  console.log('🔗 Redirecting to:', deepLink);
  res.redirect(deepLink);
});

// PayFast Failure Redirect
app.get('/api/payfastFailure', (req, res) => {
  console.log('=== PayFast Failure Redirect ===');
  console.log('Timestamp:', new Date().toISOString());
  console.log('Query params:', req.query);

  const basketId = req.query.basket_id || req.query.BASKET_ID || '';
  const errorCode = req.query.err_code || req.query.ERROR_CODE || 'UNKNOWN';
  const errorMessage = req.query.err_msg || req.query.ERROR_MESSAGE || 'Payment Failed';

  const deepLink = `echallan://payment/failure?` +
    `basket_id=${encodeURIComponent(basketId)}&` +
    `err_code=${encodeURIComponent(errorCode)}&` +
    `err_msg=${encodeURIComponent(errorMessage)}`;

  console.log('🔗 Redirecting to:', deepLink);
  res.redirect(deepLink);
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Not Found',
    path: req.path,
    availableEndpoints: [
      'GET /',
      'POST /api/payfastNotify',
      'GET /api/payfastSuccess',
      'GET /api/payfastFailure'
    ]
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/`);
});
