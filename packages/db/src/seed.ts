import { prisma } from "./index.js";

async function main() {
  console.log("Seeding database with test users...");

  await prisma.user.create({
    data: {
      phoneNumber: "+447000000001",
      nickname: "Test Sarah",
      timezone: "Europe/London",
      consentGiven: true,
      consentAt: new Date(),
      consentVersion: "v1",
      cycles: {
        create: {
          disease: "asthma",
          type: "TRIAL_7_DAY",
          status: "ACTIVE",
          startedAt: new Date(),
        },
      },
    },
  });

  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
