-- SimpleLyft: gentle follow ask (ask once, then deliver)
ALTER TABLE "Automation" ADD COLUMN "followGentle" BOOLEAN NOT NULL DEFAULT false;
