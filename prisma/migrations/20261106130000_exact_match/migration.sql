-- SimpleLyft: comment must be only the keyword
ALTER TABLE "Automation" ADD COLUMN "exactMatch" BOOLEAN NOT NULL DEFAULT false;
