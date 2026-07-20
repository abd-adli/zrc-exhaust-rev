const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Copy database SQLite ke /tmp (tanpa execSync prisma!)
if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
  try {
    const dbPath = '/tmp/dev.db';
    const possiblePaths = [
      path.join(__dirname, 'prisma', 'dev.db'),
      path.join(__dirname, 'dev.db')
    ];
    
    const localDbPath = possiblePaths.find(p => fs.existsSync(p));

    if (localDbPath && !fs.existsSync(dbPath)) {
      fs.copyFileSync(localDbPath, dbPath);
      console.log('Database successfully copied to', dbPath);
    }
  } catch (err) {
    console.error('Failed to copy db:', err);
  }
}

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const app = express();
const PORT = process.env.PORT || 3000;

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}
const logFilePath = path.join(logsDir, 'whatsapp_notifications.log');

// Helper to log simulated WhatsApp messages
let localNotificationLogs = [];
function logWhatsAppMessage(phone, recipientName, message) {
  const logEntry = {
    timestamp: new Date().toLocaleString('id-ID'),
    phone,
    recipientName,
    message
  };
  
  // Keep last 50 in memory for the admin panel
  localNotificationLogs.unshift(logEntry);
  if (localNotificationLogs.length > 50) {
    localNotificationLogs.pop();
  }

  // Append to physical log file
  const fileLine = `[${logEntry.timestamp}] To: ${recipientName} (${phone})\nMessage: ${message}\n----------------------------------------\n`;
  fs.appendFileSync(logFilePath, fileLine, 'utf8');
  console.log(`[WhatsApp Sim] Sent to ${recipientName} (${phone}): ${message.slice(0, 60)}...`);

  // Optionally trigger WhatsApp API webhook if configured
  if (process.env.WHATSAPP_WEBHOOK_URL && process.env.WHATSAPP_WEBHOOK_URL !== '' && !process.env.WHATSAPP_WEBHOOK_URL.includes("api.whatsapp.com")) {
    fetch(process.env.WHATSAPP_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, message })
    }).catch(err => console.error('Simulated webhook failed:', err.message));
  }
}

// Midtrans Snap API Integration Helper
async function createMidtransTransaction(order) {
  const serverKey = process.env.MIDTRANS_SERVER_KEY;
  const authHeader = Buffer.from(`${serverKey}:`).toString('base64');
  const isProd = process.env.MIDTRANS_IS_PRODUCTION === 'true';
  const midtransUrl = isProd 
    ? 'https://app.midtrans.com/snap/v1/transactions' 
    : 'https://app.sandbox.midtrans.com/snap/v1/transactions';

  const payload = {
    transaction_details: {
      order_id: order.id,
      gross_amount: Math.round(order.downPaymentAmount)
    },
    credit_card: {
      secure: true
    },
    customer_details: {
      first_name: order.customerName,
      phone: order.customerWhatsApp
    },
    item_details: [
      {
        id: 'DP_FABRICATION',
        price: Math.round(order.downPaymentAmount),
        quantity: 1,
        name: `Down Payment - Custom Exhaust (Vehicle: ${order.vehicleBrand} ${order.vehicleModel})`
      }
    ]
  };

  try {
    const response = await fetch(midtransUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Basic ${authHeader}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Midtrans API responded with ${response.status}: ${errText}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Midtrans Snap Transaction Error:', error);
    throw error;
  }
}

// Express Configuration
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Session setup for Admin Dashboard
app.use(session({
  secret: process.env.SESSION_SECRET || 'zrc_exhaust_default_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 Hours
}));

// Admin Authentication Middleware
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  res.redirect('/admin/login');
}

// Inject Config parameters helper to all templates
app.use(async (req, res, next) => {
  res.locals.isAdmin = !!(req.session && req.session.isAdmin);
  next();
});


/* ==========================================================================
   CLIENT-FACING ROUTING (SEO-OPTIMIZED COPIES & DATA INTERFACES)
   ========================================================================== */

// Helper to get booking slots status for a range of upcoming dates
async function getBookingSlotsForNextDays(daysCount) {
  const today = new Date();
  const dates = [];
  for (let i = 0; i < daysCount; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    dates.push(d.toISOString().split('T')[0]);
  }

  const existingSlots = await prisma.bookingSlot.findMany({
    where: { date: { in: dates } }
  });

  const slotsMap = new Map(existingSlots.map(s => [s.date, s]));
  return dates.map(dateStr => {
    return slotsMap.get(dateStr) || { date: dateStr, maxSlots: 3, bookedSlots: 0 };
  });
}

// 1. Homepage: Catalog Listings, Booking Slots & Dynamic SEO Meta keywords
app.get('/', async (req, res) => {
  try {
    const typeFilter = req.query.type; // CAR or MOTORCYCLE
    const search = req.query.search;

    let whereClause = { isReadyStock: false };
    if (typeFilter) {
      whereClause.vehicleType = typeFilter.toUpperCase();
    }
    if (search) {
      const andConditions = [
        { isReadyStock: false },
        {
          OR: [
            { brand: { contains: search } },
            { model: { contains: search } }
          ]
        }
      ];
      if (typeFilter) {
        andConditions.push({ vehicleType: typeFilter.toUpperCase() });
      }
      whereClause = { AND: andConditions };
    }

    const catalogs = await prisma.catalogItem.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' }
    });

    // Fetch booking slots status for calendar highlight
    const upcomingSlots = await getBookingSlotsForNextDays(7);

    // SEO Meta Info
    const metaTitle = "Spesialis Custom Knalpot Mobil & Motor - Fullsystem Presisi & Bergaransi | ZRC Exhaust";
    const metaDescription = "Bikin sistem gas buang kendaraan Anda lebih optimal. Pengerjaan rapi dengan las TIG/Argon berkualitas tinggi untuk performa maksimal. Pesan online langsung.";
    const metaKeywords = "Custom Knalpot Mobil, Bengkel Knalpot Terdekat, Exhaust Fullsystem Stainless, Custom Knalpot Motor, Spesialis Knalpot Custom, Knalpot Titanium, Knalpot Stainless, ZRC Exhaust";

    res.render('index', { 
      catalogs, 
      upcomingSlots, 
      typeFilter, 
      search,
      metaTitle,
      metaDescription,
      metaKeywords
    });
  } catch (error) {
    console.error('Error fetching catalog/slots:', error);
    res.status(500).send('Internal Server Error');
  }
});

// 2. Soundroom: Dedicated Audio Player Section for exhaust sounds check
app.get('/soundroom', async (req, res) => {
  try {
    const catalogs = await prisma.catalogItem.findMany({
      where: { isReadyStock: false },
      orderBy: { brand: 'asc' }
    });

    const metaTitle = "Soundroom Check - Dengarkan Knalpot Custom Presisi | ZRC Exhaust";
    const metaDescription = "Dengarkan sampel suara knalpot mobil & motor hasil fabrikasi ZRC Exhaust. Dari suara bass adem bulat hingga screamer melengking.";
    const metaKeywords = "Suara Knalpot Custom, Cek Sound Knalpot, Exhaust Sound Room, Knalpot Racing Adhem, ZRC Soundroom";

    res.render('soundroom', { 
      catalogs,
      soundroomPage: true,
      metaTitle,
      metaDescription,
      metaKeywords
    });
  } catch (error) {
    console.error('Error loading soundroom:', error);
    res.status(500).send('Error loading Soundroom');
  }
});

// 2b. Ready Stock (PNP) Catalog Page
app.get('/catalog', async (req, res) => {
  try {
    const typeFilter = req.query.type; // CAR or MOTORCYCLE
    const search = req.query.search;

    let whereClause = { isReadyStock: true };
    if (typeFilter) {
      whereClause.vehicleType = typeFilter.toUpperCase();
    }
    if (search) {
      const andConditions = [
        { isReadyStock: true },
        {
          OR: [
            { brand: { contains: search } },
            { model: { contains: search } }
          ]
        }
      ];
      if (typeFilter) {
        andConditions.push({ vehicleType: typeFilter.toUpperCase() });
      }
      whereClause = { AND: andConditions };
    }

    const catalogs = await prisma.catalogItem.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' }
    });

    const metaTitle = "Knalpot Ready Stock PNP - Spesialis Knalpot Custom Siap Pakai | ZRC Exhaust";
    const metaDescription = "Dapatkan knalpot premium PNP (Plug and Play) ZRC Exhaust. Ready stock siap kirim atau pasang langsung ke bengkel, kualitas las argon presisi bergaransi.";
    const metaKeywords = "Knalpot Ready Stock PNP, Spesialis Knalpot Custom, Knalpot Plug and Play, ZRC Exhaust Jogja, Knalpot Stainless PNP";

    res.render('catalog', { 
      catalogs,
      typeFilter,
      search,
      metaTitle,
      metaDescription,
      metaKeywords
    });
  } catch (error) {
    console.error('Error loading ready stock catalog:', error);
    res.status(500).send('Error loading Catalog Ready Stock');
  }
});

// 3. Custom Order Form Configuration
app.get('/order', async (req, res) => {
  try {
    // Get booking slots available (bookedSlots < maxSlots)
    const availableSlots = await getBookingSlotsForNextDays(14);

    const dpPercentageSetting = await prisma.systemSetting.findUnique({
      where: { key: 'DP_PERCENTAGE' }
    });
    const dpPercent = dpPercentageSetting ? parseFloat(dpPercentageSetting.value) : 30;

    // Get specific preset info if user clicked configure from a catalog item
    const { brand, model, price, components } = req.query;

    const metaTitle = "Custom Exhaust Booking & Konfigurator | ZRC Exhaust";
    const metaDescription = "Rancang knalpot mobil atau motor impian Anda secara mandiri. Hitung estimasi harga, tentukan material Stainless/Titanium, dan booking tanggal fabrikasi.";
    const metaKeywords = "Booking Knalpot Custom, Custom Knalpot Mobil Yogyakarta, Fabrikasi Knalpot Stainless, Pesan Knalpot Titanium";

    res.render('order', { 
      availableSlots, 
      dpPercent,
      presetBrand: brand || '',
      presetModel: model || '',
      presetPrice: price || '',
      presetComponents: components || '',
      metaTitle,
      metaDescription,
      metaKeywords
    });
  } catch (error) {
    console.error('Error loading order form:', error);
    res.status(500).send('Error loading Order Form');
  }
});

// JSON API: check slot count for date
app.get('/api/booking/check', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'Date is required' });

    let slot = await prisma.bookingSlot.findUnique({ where: { date } });
    if (!slot) {
      // Default slots
      return res.json({ date, maxSlots: 3, bookedSlots: 0, available: true });
    }
    
    res.json({
      date,
      maxSlots: slot.maxSlots,
      bookedSlots: slot.bookedSlots,
      available: slot.bookedSlots < slot.maxSlots
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error checking slots' });
  }
});

// 4. Submit Custom Order
app.post('/order', async (req, res) => {
  try {
    const {
      customerName,
      customerWhatsApp,
      vehicleBrand,
      vehicleModel,
      vehicleYear,
      vehicleEngine,
      material,
      pipingDiameter,
      mufflerType,
      soundRequest,
      bookingDate,
      totalEstimatedPrice
    } = req.body;

    // Check if slot is available
    let slot = await prisma.bookingSlot.findUnique({ where: { date: bookingDate } });
    if (slot && slot.bookedSlots >= slot.maxSlots) {
      return res.status(400).send('Booking date is fully booked. Please choose another date.');
    }

    const price = parseFloat(totalEstimatedPrice) || 5000000;
    
    // Get DP percentage
    const dpPercentageSetting = await prisma.systemSetting.findUnique({
      where: { key: 'DP_PERCENTAGE' }
    });
    const dpPercent = dpPercentageSetting ? parseFloat(dpPercentageSetting.value) : 30;
    const dpAmount = (price * dpPercent) / 100;

    // Create the order in db
    const order = await prisma.customOrder.create({
      data: {
        customerName,
        customerWhatsApp,
        vehicleBrand,
        vehicleModel,
        vehicleYear,
        vehicleEngine,
        material,
        pipingDiameter,
        mufflerType,
        soundRequest,
        orderStatus: 'PENDING_CONSULTATION',
        paymentStatus: 'UNPAID',
        totalPrice: price,
        downPaymentAmount: dpAmount,
        bookingDate
      }
    });

    // Increment booked slots count
    if (slot) {
      await prisma.bookingSlot.update({
        where: { date: bookingDate },
        data: { bookedSlots: slot.bookedSlots + 1 }
      });
    } else {
      await prisma.bookingSlot.create({
        data: { date: bookingDate, maxSlots: 3, bookedSlots: 1 }
      });
    }

    // Call Midtrans Snap to generate token
    let snapToken = null;
    try {
      const snapResult = await createMidtransTransaction(order);
      snapToken = snapResult.token;

      // Save token back to order
      await prisma.customOrder.update({
        where: { id: order.id },
        data: { paymentToken: snapToken }
      });
    } catch (midtransError) {
      console.error('Failed to register Midtrans transaction:', midtransError.message);
      // Fallback: Assign mock token for local testing/demo simulation
      snapToken = `mock-${order.id}`;
      await prisma.customOrder.update({
        where: { id: order.id },
        data: { paymentToken: snapToken }
      });
      console.log(`[Developer Demo Mode] Assigned mock token to Order ${order.id}`);
    }

    // Trigger WhatsApp notification for order placement
    const formattedPrice = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(price);
    const formattedDP = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(dpAmount);
    
    const customerMsg = `Halo *${customerName}*,\n\nPesanan custom exhaust Anda (*${vehicleBrand} ${vehicleModel}*) telah terdaftar di *ZRC Exhaust*!\n\nJadwal Booking: *${bookingDate}*\nEstimasi Total: *${formattedPrice}*\nDown Payment (DP ${dpPercent}%): *${formattedDP}*\n\nSilakan selesaikan pembayaran DP Anda untuk mengunci jadwal fabrikasi.\nLink Invoice: http://localhost:${PORT}/order/success/${order.id}\n\nTerima kasih!`;
    const ownerMsg = `[ZRC NOTIF] Pesanan Baru!\n\nNama: ${customerName}\nWA: ${customerWhatsApp}\nKendaraan: ${vehicleBrand} ${vehicleModel} (${vehicleYear})\nBahan: ${material}\nBooking Date: ${bookingDate}\nTotal: ${formattedPrice}\nDP: ${formattedDP}\n\nDetail: http://localhost:${PORT}/admin/orders`;

    logWhatsAppMessage(customerWhatsApp, customerName, customerMsg);
    logWhatsAppMessage('08123456789', 'Owner ZRC Exhaust', ownerMsg); // Hardcoded Owner WA number

    res.redirect(`/order/success/${order.id}`);
  } catch (error) {
    console.error('Error submitting order:', error);
    res.status(500).send('Error saving Custom Order');
  }
});

// 5. Order Success / Pay Invoice Page
app.get('/order/success/:id', async (req, res) => {
  try {
    const order = await prisma.customOrder.findUnique({
      where: { id: req.params.id }
    });

    if (!order) {
      return res.status(404).send('Order not found');
    }

    const clientKey = process.env.MIDTRANS_CLIENT_KEY;

    // Dynamically update page tags based on order vehicle type for SEO value
    const metaTitle = `Invoice Custom Knalpot ${order.vehicleBrand} ${order.vehicleModel} | ZRC Exhaust`;
    const metaDescription = `Selesaikan pembayaran Down Payment Anda untuk mengunci antrean fabrikasi custom knalpot ${order.vehicleBrand} pada ${order.bookingDate}.`;
    const metaKeywords = `Invoice Knalpot, Booking Knalpot ${order.vehicleBrand}, Knalpot Custom Jogja`;

    res.render('order_success', { 
      order, 
      clientKey,
      metaTitle,
      metaDescription,
      metaKeywords
    });
  } catch (error) {
    console.error('Error fetching success page:', error);
    res.status(500).send('Error showing success page');
  }
});


/* ==========================================================================
   MIDTRANS WEBHOOK HANDLER & LOCAL SIMULATION
   ========================================================================== */

// 6. Secure webhook receiver
app.post('/api/payment/webhook', async (req, res) => {
  try {
    const {
      order_id,
      transaction_status,
      fraud_status,
      gross_amount,
      signature_key,
      status_code
    } = req.body;

    console.log(`[Midtrans Webhook] Received status for Order ${order_id}: ${transaction_status}`);

    // Verify signature key to secure webhook
    const rawString = order_id + status_code + gross_amount + process.env.MIDTRANS_SERVER_KEY;
    const hash = crypto.createHash('sha512').update(rawString).digest('hex');

    if (hash !== signature_key) {
      console.warn('[Midtrans Webhook] Signature check FAILED!');
      return res.status(403).json({ error: 'Invalid signature key' });
    }

    // Find the order
    const order = await prisma.customOrder.findUnique({ where: { id: order_id } });
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    let updatedPaymentStatus = order.paymentStatus;
    let updatedOrderStatus = order.orderStatus;

    if (transaction_status === 'settlement' || transaction_status === 'capture') {
      // Payment Successful
      updatedPaymentStatus = 'DP_PAID';
      updatedOrderStatus = 'FABRICATION'; // Automatically push to fabrication

      // Send WhatsApp Notification to Customer & Owner
      const formattedDP = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(order.downPaymentAmount);
      
      const customerMsg = `Halo *${order.customerName}*,\n\nPembayaran DP sebesar *${formattedDP}* untuk pesanan custom exhaust *${order.vehicleBrand} ${order.vehicleModel}* telah kami terima.\n\nStatus pesanan Anda telah diperbarui menjadi: *FABRICATION (Dalam Pengerjaan)*.\n\nJadwal pengerjaan Anda: *${order.bookingDate}*.\nKami akan menghubungi Anda jika ada fitting tambahan. Terimakasih!`;
      const ownerMsg = `[ZRC NOTIF] Pembayaran DP Lunas!\n\nNama: ${order.customerName}\nKendaraan: ${order.vehicleBrand} ${order.vehicleModel}\nJumlah: ${formattedDP}\nBooking Date: ${order.bookingDate}\nStatus Order: FABRICATION.\n\nSilakan cek Dashboard Admin.`;

      logWhatsAppMessage(order.customerWhatsApp, order.customerName, customerMsg);
      logWhatsAppMessage('08123456789', 'Owner ZRC Exhaust', ownerMsg);
    } else if (transaction_status === 'pending') {
      updatedPaymentStatus = 'UNPAID';
    } else if (transaction_status === 'deny' || transaction_status === 'expire' || transaction_status === 'cancel') {
      updatedPaymentStatus = 'UNPAID';
      // Release booking slot if cancelled/expired
      const slot = await prisma.bookingSlot.findUnique({ where: { date: order.bookingDate } });
      if (slot && slot.bookedSlots > 0) {
        await prisma.bookingSlot.update({
          where: { date: order.bookingDate },
          data: { bookedSlots: slot.bookedSlots - 1 }
        });
      }
    }

    // Update in database
    await prisma.customOrder.update({
      where: { id: order_id },
      data: {
        paymentStatus: updatedPaymentStatus,
        orderStatus: updatedOrderStatus
      }
    });

    res.json({ status: 'OK', paymentStatus: updatedPaymentStatus, orderStatus: updatedOrderStatus });
  } catch (error) {
    console.error('[Webhook Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

// 6b. Test/Demo route: Simulate payment success from frontend
app.post('/api/payment/simulate-success', async (req, res) => {
  try {
    const { orderId } = req.body;
    const order = await prisma.customOrder.findUnique({ where: { id: orderId } });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Construct mock Midtrans webhook signature payload
    const statusCode = "200";
    const grossAmount = Math.round(order.downPaymentAmount).toString();
    const rawString = order.id + statusCode + grossAmount + process.env.MIDTRANS_SERVER_KEY;
    const signatureKey = crypto.createHash('sha512').update(rawString).digest('hex');

    // Trigger local webhook handler internally
    const response = await fetch(`http://localhost:${PORT}/api/payment/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order_id: order.id,
        transaction_status: 'settlement',
        fraud_status: 'accept',
        gross_amount: grossAmount,
        signature_key: signatureKey,
        status_code: statusCode
      })
    });

    const result = await response.json();
    res.json(result);
  } catch (error) {
    console.error('Simulation payment error:', error);
    res.status(500).json({ error: error.message });
  }
});


/* ==========================================================================
   ADMIN DASHBOARD & CRUD CONTROLLER
   ========================================================================== */

// 7. Login Page
app.get('/admin/login', (req, res) => {
  if (req.session && req.session.isAdmin) {
    return res.redirect('/admin/dashboard');
  }
  res.render('admin_login', { 
    error: null,
    metaTitle: "Admin Login - ZRC Exhaust",
    metaDescription: "Log masuk ke panel admin ZRC Exhaust untuk mengelola katalog, booking slot, dan detail order custom.",
    metaKeywords: "Admin ZRC"
  });
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const bcrypt = require('bcryptjs');
  
  if (username === process.env.ADMIN_USERNAME && bcrypt.compareSync(password, process.env.ADMIN_PASSWORD_HASH)) {
    req.session.isAdmin = true;
    req.session.username = username;
    return res.redirect('/admin/dashboard');
  }

  res.render('admin_login', { 
    error: 'Username atau Password salah!',
    metaTitle: "Admin Login - ZRC Exhaust",
    metaDescription: "Log masuk ke panel admin ZRC Exhaust",
    metaKeywords: "Admin ZRC"
  });
});

// Logout
app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// 8. Main Dashboard Home
app.get('/admin/dashboard', requireAdmin, async (req, res) => {
  try {
    const ordersCount = await prisma.customOrder.count();
    const catalogsCount = await prisma.catalogItem.count();
    const activeFabrications = await prisma.customOrder.count({
      where: { orderStatus: 'FABRICATION' }
    });
    const completedOrders = await prisma.customOrder.count({
      where: { orderStatus: 'COMPLETED' }
    });

    // Recent orders
    const recentOrders = await prisma.customOrder.findMany({
      orderBy: { createdAt: 'desc' },
      take: 5
    });

    // Settings
    const dpSetting = await prisma.systemSetting.findUnique({ where: { key: 'DP_PERCENTAGE' } });
    const currentDP = dpSetting ? dpSetting.value : '30';

    res.render('admin_dashboard', {
      ordersCount,
      catalogsCount,
      activeFabrications,
      completedOrders,
      recentOrders,
      currentDP,
      notificationLogs: localNotificationLogs,
      adminPage: true,
      metaTitle: "Dashboard Admin | ZRC Exhaust",
      metaDescription: "Ringkasan statistik pengerjaan knalpot, riwayat pesanan, dan log sistem.",
      metaKeywords: "Admin Dashboard"
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('Error loading dashboard');
  }
});

// Route: Update DP settings
app.post('/admin/settings/dp', requireAdmin, async (req, res) => {
  try {
    const { dpPercentage } = req.body;
    await prisma.systemSetting.upsert({
      where: { key: 'DP_PERCENTAGE' },
      update: { value: dpPercentage.toString() },
      create: { key: 'DP_PERCENTAGE', value: dpPercentage.toString() }
    });
    res.redirect('/admin/dashboard');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error updating settings');
  }
});

// 9. Catalog CRUD Listings
app.get('/admin/catalogs', requireAdmin, async (req, res) => {
  try {
    const catalogs = await prisma.catalogItem.findMany({
      orderBy: { createdAt: 'desc' }
    });
    res.render('admin_catalogs', { 
      catalogs,
      adminPage: true,
      metaTitle: "Kelola Katalog Preset | ZRC Exhaust Admin",
      metaDescription: "CRUD Management untuk mobil/motor preset, komponen knalpot custom, harga, dan kata kunci SEO.",
      metaKeywords: "Admin Catalog"
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('Error loading catalogs CRUD');
  }
});

// Create Catalog
app.post('/admin/catalogs/create', requireAdmin, async (req, res) => {
  try {
    const { brand, model, vehicleType, exhaustComponents, price, description, images, soundClipUrl, seoKeywords } = req.body;
    const isReadyStock = req.body.isReadyStock === 'on' || req.body.isReadyStock === 'true';
    const stock = parseInt(req.body.stock) || 0;
    
    // Parse image URLs or use default
    let imageArray = ['/images/exhaust_generic.jpg'];
    if (images && images.trim() !== '') {
      imageArray = images.split(',').map(img => img.trim());
    }

    // Process exhaustComponents checkboxes or input
    let comps = '';
    if (Array.isArray(exhaustComponents)) {
      comps = exhaustComponents.join(',');
    } else if (exhaustComponents) {
      comps = exhaustComponents;
    }

    await prisma.catalogItem.create({
      data: {
        brand,
        model,
        vehicleType,
        exhaustComponents: comps,
        price: parseFloat(price),
        description,
        images: JSON.stringify(imageArray),
        soundClipUrl: soundClipUrl || '/audio/generic.mp3',
        seoKeywords: seoKeywords || 'Custom Knalpot',
        isReadyStock,
        stock
      }
    });
    res.redirect('/admin/catalogs');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error creating catalog item');
  }
});

// Update Catalog
app.post('/admin/catalogs/update/:id', requireAdmin, async (req, res) => {
  try {
    const { brand, model, vehicleType, exhaustComponents, price, description, images, soundClipUrl, seoKeywords } = req.body;
    const isReadyStock = req.body.isReadyStock === 'on' || req.body.isReadyStock === 'true';
    const stock = parseInt(req.body.stock) || 0;
    
    let imageArray = ['/images/exhaust_generic.jpg'];
    if (images && images.trim() !== '') {
      imageArray = images.split(',').map(img => img.trim());
    }

    let comps = '';
    if (Array.isArray(exhaustComponents)) {
      comps = exhaustComponents.join(',');
    } else if (exhaustComponents) {
      comps = exhaustComponents;
    }

    await prisma.catalogItem.update({
      where: { id: req.params.id },
      data: {
        brand,
        model,
        vehicleType,
        exhaustComponents: comps,
        price: parseFloat(price),
        description,
        images: JSON.stringify(imageArray),
        soundClipUrl: soundClipUrl || '/audio/generic.mp3',
        seoKeywords: seoKeywords || 'Custom Knalpot',
        isReadyStock,
        stock
      }
    });
    res.redirect('/admin/catalogs');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error updating catalog item');
  }
});

// Delete Catalog
app.post('/admin/catalogs/delete/:id', requireAdmin, async (req, res) => {
  try {
    await prisma.catalogItem.delete({
      where: { id: req.params.id }
    });
    res.redirect('/admin/catalogs');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error deleting catalog item');
  }
});

// 10. Orders Management CRUD (Read, Update Status, Update Payment, Delete)
app.get('/admin/orders', requireAdmin, async (req, res) => {
  try {
    const orders = await prisma.customOrder.findMany({
      orderBy: { createdAt: 'desc' }
    });
    res.render('admin_orders', { 
      orders,
      adminPage: true,
      metaTitle: "Kelola Pesanan Custom | ZRC Exhaust Admin",
      metaDescription: "Pantau pengerjaan custom exhaust, material titanium/stainless, status down payment, dan jadwal antrean.",
      metaKeywords: "Admin Orders"
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('Error loading orders CRUD');
  }
});

// Update Order Status / Payment
app.post('/admin/orders/update/:id', requireAdmin, async (req, res) => {
  try {
    const { orderStatus, paymentStatus } = req.body;
    const oldOrder = await prisma.customOrder.findUnique({ where: { id: req.params.id } });

    const updatedOrder = await prisma.customOrder.update({
      where: { id: req.params.id },
      data: { orderStatus, paymentStatus }
    });

    // Check if status changed and notify customer
    if (oldOrder.orderStatus !== orderStatus || oldOrder.paymentStatus !== paymentStatus) {
      let statusName = '';
      switch (orderStatus) {
        case 'PENDING_CONSULTATION': statusName = 'Pending Konsultasi'; break;
        case 'WAITING_FOR_DP': statusName = 'Menunggu Pembayaran DP'; break;
        case 'FABRICATION': statusName = 'Dalam Pengerjaan Fabrikasi'; break;
        case 'FITTING': statusName = 'Jadwal Fitting Kendaraan'; break;
        case 'COMPLETED': statusName = 'Pesanan Selesai'; break;
      }

      const formattedTotal = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(updatedOrder.totalPrice);

      const customerMsg = `Halo *${updatedOrder.customerName}*,\n\nStatus pesanan ZRC Exhaust Anda telah diperbarui!\n\nStatus Baru: *${statusName}*\nStatus Pembayaran: *${paymentStatus}*\nDetail Kendaraan: *${updatedOrder.vehicleBrand} ${updatedOrder.vehicleModel}*\nEstimasi Total: *${formattedTotal}*\n\nJika ada pertanyaan, silakan hubungi admin kami. Terima kasih!`;
      logWhatsAppMessage(updatedOrder.customerWhatsApp, updatedOrder.customerName, customerMsg);
    }

    res.redirect('/admin/orders');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error updating order');
  }
});

// Delete Order
app.post('/admin/orders/delete/:id', requireAdmin, async (req, res) => {
  try {
    const order = await prisma.customOrder.findUnique({ where: { id: req.params.id } });
    if (order) {
      // Release booking slot count
      const slot = await prisma.bookingSlot.findUnique({ where: { date: order.bookingDate } });
      if (slot && slot.bookedSlots > 0) {
        await prisma.bookingSlot.update({
          where: { date: order.bookingDate },
          data: { bookedSlots: slot.bookedSlots - 1 }
        });
      }
      
      await prisma.customOrder.delete({
        where: { id: req.params.id }
      });
    }
    res.redirect('/admin/orders');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error deleting order');
  }
});

// 11. Booking Slots CRUD Override
app.get('/admin/slots', requireAdmin, async (req, res) => {
  try {
    const todayStr = new Date().toISOString().split('T')[0];
    const slots = await prisma.bookingSlot.findMany({
      where: { date: { gte: todayStr } },
      orderBy: { date: 'asc' },
      take: 45
    });
    res.render('admin_slots', { 
      slots,
      adminPage: true,
      metaTitle: "Atur Slot Antrean Harian | ZRC Exhaust Admin",
      metaDescription: "Kelola kuota maksimal pengerjaan knalpot harian untuk menjaga kualitas las argon.",
      metaKeywords: "Admin Slots"
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('Error loading booking slots CRUD');
  }
});

// Add or Update Slot Limit
app.post('/admin/slots/save', requireAdmin, async (req, res) => {
  try {
    const { date, maxSlots } = req.body;
    const maxVal = parseInt(maxSlots) || 3;

    await prisma.bookingSlot.upsert({
      where: { date },
      update: { maxSlots: maxVal },
      create: { date, maxSlots: maxVal, bookedSlots: 0 }
    });

    res.redirect('/admin/slots');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error updating slot limit');
  }
});

// Delete Slot Limit override
app.post('/admin/slots/delete/:id', requireAdmin, async (req, res) => {
  try {
    await prisma.bookingSlot.delete({
      where: { id: req.params.id }
    });
    res.redirect('/admin/slots');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error resetting slot limit');
  }
});


// Start Express Server
app.listen(PORT, () => {
  console.log(`ZRC Exhaust backend running on http://localhost:${PORT}`);
});

// Tangkap error tersembunyi jika database gagal connect
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception thrown:', err);
});