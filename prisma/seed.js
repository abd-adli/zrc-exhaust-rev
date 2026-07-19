const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Seeding started...');

  // 1. Seed System Settings
  await prisma.systemSetting.upsert({
    where: { key: 'DP_PERCENTAGE' },
    update: {},
    create: { key: 'DP_PERCENTAGE', value: '30' }
  });
  console.log('System settings seeded.');

  // 2. Seed Catalog Items
  // Make sure we seed values that conform to the new schema fields:
  // - exhaustComponents (Comma-separated components)
  // - seoKeywords (Comma-separated keywords)
  const catalogs = [
    {
      brand: 'Honda',
      model: 'Civic Type R FL5',
      vehicleType: 'CAR',
      exhaustComponents: 'Downpipe,Frontpipe,Centerpipe,Muffler,Fullsystem',
      price: 15500000,
      description: 'ZRC Exhaust Valvetronic System. Handcrafted from premium Grade 5 Titanium. Features active valve control allowing you to switch between Silent Mode (stealthy daily driving) and Racing Mode (maximum performance and aggressive growl). Dual tips with burnt blue finish.',
      images: JSON.stringify(['/images/civic_fl5_1.jpg', '/images/civic_fl5_2.jpg']),
      soundClipUrl: '/audio/civic_type_r.mp3',
      seoKeywords: 'Custom Knalpot Mobil, Bengkel Knalpot Terdekat, Exhaust Fullsystem Stainless, Spesialis Knalpot Custom'
    },
    {
      brand: 'Toyota',
      model: 'GR Yaris',
      vehicleType: 'CAR',
      exhaustComponents: 'Frontpipe,Centerpipe,Muffler,Fullsystem',
      price: 12800000,
      description: 'ZRC SUS304 Stainless Steel Full System. Features high-flow frontpipe, centerpipe, and sport muffler. Delivers a deep, bassy exhaust tone that accentuates the sporty character of the GR Yaris without drone.',
      images: JSON.stringify(['/images/gr_yaris_1.jpg']),
      soundClipUrl: '/audio/gr_yaris.mp3',
      seoKeywords: 'Custom Knalpot Mobil, Exhaust Fullsystem Stainless, Bengkel Knalpot Terdekat, Spesialis Knalpot Custom'
    },
    {
      brand: 'Kawasaki',
      model: 'Ninja ZX-25R',
      vehicleType: 'MOTORCYCLE',
      exhaustComponents: 'Header,Muffler,Fullsystem',
      price: 7800000,
      description: 'ZRC Fullsystem Screamer Carbon. Specially engineered for the high-revving inline-4 engine. Experience the ultimate F1-style high-pitched scream at 17,000 RPM. Complete header and carbon fiber canister package.',
      images: JSON.stringify(['/images/zx25r_1.jpg', '/images/zx25r_2.jpg']),
      soundClipUrl: '/audio/zx25r.mp3',
      seoKeywords: 'Custom Knalpot Motor, Spesialis Knalpot Custom, Bengkel Knalpot Terdekat'
    },
    {
      brand: 'Yamaha',
      model: 'YZF-R6',
      vehicleType: 'MOTORCYCLE',
      exhaustComponents: 'Header,Muffler,Fullsystem',
      price: 9500000,
      description: 'ZRC Burnt Blue Titanium GP Exhaust. Full race exhaust system. Saves 4.5kg of weight compared to stock, while maximizing mid-range power and giving a brutal, raw superbike sound check.',
      images: JSON.stringify(['/images/r6_1.jpg']),
      soundClipUrl: '/audio/r6.mp3',
      seoKeywords: 'Custom Knalpot Motor, Exhaust Fullsystem Stainless, Spesialis Knalpot Custom, Bengkel Knalpot Terdekat'
    }
  ];

  for (const catalog of catalogs) {
    await prisma.catalogItem.create({
      data: catalog
    });
  }
  console.log('Catalog items seeded.');

  // 3. Seed Booking Slots for the next 30 days
  const today = new Date();
  for (let i = 0; i < 30; i++) {
    const targetDate = new Date();
    targetDate.setDate(today.getDate() + i);
    const dateString = targetDate.toISOString().split('T')[0];

    // Seed 3 slots per day
    await prisma.bookingSlot.upsert({
      where: { date: dateString },
      update: {},
      create: {
        date: dateString,
        maxSlots: 3,
        bookedSlots: i % 7 === 0 ? 3 : (i % 3 === 0 ? 1 : 0) // Mix of booked slots for testing
      }
    });
  }
  console.log('Booking slots seeded.');

  console.log('Seeding completed successfully!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
