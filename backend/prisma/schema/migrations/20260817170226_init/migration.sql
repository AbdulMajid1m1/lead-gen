-- CreateEnum
CREATE TYPE "ConfidenceLevel" AS ENUM ('VERIFIED', 'DETECTED', 'INFERRED', 'AI_GENERATED');

-- CreateEnum
CREATE TYPE "ServiceType" AS ENUM ('WEBSITE_DEV', 'CRM_DEV', 'MOBILE_APP', 'AI_AUTOMATION', 'ECOMMERCE_DEV', 'SAAS_DEV', 'CUSTOM_SOFTWARE');

-- CreateEnum
CREATE TYPE "SourceKind" AS ENUM ('OVERPASS', 'NOMINATIM', 'ATS_GREENHOUSE', 'ATS_LEVER', 'ATS_ASHBY', 'ATS_SMARTRECRUITERS', 'ATS_WORKABLE', 'ATS_RECRUITEE', 'AGG_ARBEITNOW', 'AGG_REMOTIVE', 'AGG_JOBICY', 'AGG_ADZUNA', 'HN_HIRING', 'CRTSH', 'WIKIDATA', 'WEBSITE_CRAWL', 'MANUAL');

-- CreateEnum
CREATE TYPE "CrawlStatus" AS ENUM ('QUEUED', 'FETCHING', 'SUCCESS', 'BLOCKED', 'ROBOTS_DENIED', 'SSRF_BLOCKED', 'TIMEOUT', 'ERROR');

-- CreateEnum
CREATE TYPE "RobotsDecision" AS ENUM ('ALLOWED', 'DENIED', 'NO_ROBOTS', 'UNREACHABLE');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('ACTIVE', 'RECENTLY_ACTIVE', 'EXPIRED', 'CLOSED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SignalType" AS ENUM ('NO_WEBSITE', 'OUTDATED_WEBSITE', 'NO_HTTPS', 'NO_MOBILE_VIEWPORT', 'SLOW_SITE', 'OLD_COPYRIGHT', 'LEGACY_JS_LIB', 'WORDPRESS_DETECTED', 'WOOCOMMERCE_DETECTED', 'SHOPIFY_DETECTED', 'WIX_SQUARESPACE', 'MAGENTO_LEGACY', 'NO_ONLINE_ORDERING', 'NO_BOOKING_SYSTEM', 'NO_SCHEMA_ORG', 'NO_ANALYTICS', 'HIRING_TECH_ROLE', 'HIRING_CRM_ROLE', 'HIRING_ECOM_ROLE', 'HIRING_MOBILE_ROLE', 'HIRING_AI_ROLE', 'HIRING_MANY_ROLES', 'NEW_DOMAIN', 'NEW_SUBDOMAIN', 'CAREERS_PAGE_ACTIVE', 'CONTACT_EMAIL_FOUND', 'CONTACT_PHONE_FOUND', 'CONTACT_FORM_FOUND', 'GROWTH_MENTION', 'MANUAL_PROCESS_HINT');

-- CreateEnum
CREATE TYPE "LeadType" AS ENUM ('TECH_DEBT', 'HIRING_INTENT', 'NEW_BUSINESS', 'DIGITAL_GAP', 'EXPANSION');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'QUALIFIED', 'CONTACTED', 'FOLLOW_UP', 'INTERESTED', 'CONVERTED', 'NOT_INTERESTED', 'DISQUALIFIED', 'ARCHIVED', 'DO_NOT_CONTACT');

-- CreateEnum
CREATE TYPE "ActionType" AS ENUM ('CONTACT_IMMEDIATELY', 'EMAIL_PITCH', 'PHONE_CALL', 'CONTACT_FORM_MSG', 'SEND_AUDIT_REPORT', 'PROPOSE_MEETING', 'RESEARCH_FURTHER', 'FOLLOW_UP_LATER', 'LOW_PRIORITY', 'DO_NOT_CONTACT');

-- CreateEnum
CREATE TYPE "OutreachChannel" AS ENUM ('EMAIL', 'PHONE', 'CONTACT_FORM', 'SOCIAL');

-- CreateEnum
CREATE TYPE "DiscoveryTrigger" AS ENUM ('SEED', 'SCHEDULED', 'NL_QUERY', 'MANUAL');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ParserUsed" AS ENUM ('DETERMINISTIC', 'LLM', 'RULE');

-- CreateEnum
CREATE TYPE "SuppressionKind" AS ENUM ('DOMAIN', 'EMAIL', 'COMPANY', 'PHONE');

-- CreateEnum
CREATE TYPE "DedupeKind" AS ENUM ('DOMAIN', 'OSM_ID', 'ATS_SLUG', 'PHONE', 'NAME_CITY');

-- CreateEnum
CREATE TYPE "ContactKind" AS ENUM ('EMAIL', 'PHONE', 'CONTACT_FORM', 'SOCIAL');

-- CreateEnum
CREATE TYPE "CompanySizeBucket" AS ENUM ('MICRO', 'SMALL', 'MEDIUM', 'LARGE', 'UNKNOWN');

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "normalizedName" VARCHAR(255) NOT NULL,
    "industry" VARCHAR(100),
    "osmCategory" VARCHAR(100),
    "sizeBucket" "CompanySizeBucket" NOT NULL DEFAULT 'UNKNOWN',
    "description" TEXT,
    "countryCode" VARCHAR(2),
    "city" VARCHAR(120),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastEnrichedAt" TIMESTAMP(3),
    "lastCrawledAt" TIMESTAMP(3),

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyDomain" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "domain" VARCHAR(255) NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "httpsOk" BOOLEAN,
    "firstCertSeenAt" TIMESTAMP(3),
    "discoveredVia" "SourceKind" NOT NULL,

    CONSTRAINT "CompanyDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyAlias" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "alias" VARCHAR(255) NOT NULL,

    CONSTRAINT "CompanyAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" "ContactKind" NOT NULL,
    "value" VARCHAR(500) NOT NULL,
    "roleHint" VARCHAR(100),
    "confidenceLevel" "ConfidenceLevel" NOT NULL,
    "sourceRecordId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "isSuppressed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "lat" DOUBLE PRECISION,
    "lon" DOUBLE PRECISION,
    "addressLine" TEXT,
    "city" VARCHAR(120),
    "region" VARCHAR(120),
    "country" VARCHAR(2),
    "postalCode" VARCHAR(20),
    "osmType" VARCHAR(10),
    "osmId" BIGINT,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AtsAccount" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "provider" "SourceKind" NOT NULL,
    "slug" VARCHAR(160) NOT NULL,
    "boardUrl" TEXT,
    "lastFetchedAt" TIMESTAMP(3),
    "lastJobCount" INTEGER NOT NULL DEFAULT 0,
    "consecutiveFails" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "AtsAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeoPlace" (
    "id" TEXT NOT NULL,
    "query" VARCHAR(300) NOT NULL,
    "displayName" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "boundingBox" JSONB,
    "osmType" VARCHAR(10),
    "osmId" BIGINT,
    "countryCode" VARCHAR(2),
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeoPlace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrawlRequest" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "urlHash" VARCHAR(64) NOT NULL,
    "host" VARCHAR(255) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 50,
    "status" "CrawlStatus" NOT NULL DEFAULT 'QUEUED',
    "robotsDecision" "RobotsDecision",
    "companyId" TEXT,
    "discoveryRunId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrawlRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrawlResult" (
    "id" TEXT NOT NULL,
    "crawlRequestId" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "blockReason" VARCHAR(60),
    "blockDetail" VARCHAR(500),
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "contentType" VARCHAR(100),
    "bytes" INTEGER,
    "totalMs" INTEGER,
    "contentHash" VARCHAR(64),
    "finalUrl" TEXT,
    "redirectChain" JSONB,
    "jsRendered" BOOLEAN NOT NULL DEFAULT false,
    "sourceRecordId" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrawlResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RobotsCache" (
    "host" VARCHAR(255) NOT NULL,
    "content" TEXT,
    "crawlDelaySec" INTEGER,
    "httpStatus" INTEGER,
    "denyAll" BOOLEAN NOT NULL DEFAULT false,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RobotsCache_pkey" PRIMARY KEY ("host")
);

-- CreateTable
CREATE TABLE "HostCrawlState" (
    "host" VARCHAR(255) NOT NULL,
    "lastRequestAt" TIMESTAMP(3),
    "cooldownUntil" TIMESTAMP(3),
    "cooldownReason" VARCHAR(80),
    "errorStreak" INTEGER NOT NULL DEFAULT 0,
    "totalCrawled" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "HostCrawlState_pkey" PRIMARY KEY ("host")
);

-- CreateTable
CREATE TABLE "ExtractedFact" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "value" VARCHAR(2000),
    "valueJson" JSONB,
    "confidenceLevel" "ConfidenceLevel" NOT NULL,
    "extractorName" VARCHAR(60) NOT NULL,
    "extractorVersion" VARCHAR(20) NOT NULL,
    "evidenceSnippet" VARCHAR(1000),
    "sourceRecordId" TEXT,
    "crawlResultId" TEXT,
    "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtractedFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TechnologyDetection" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "domainId" TEXT,
    "techSlug" VARCHAR(60) NOT NULL,
    "techName" VARCHAR(100) NOT NULL,
    "category" VARCHAR(60) NOT NULL,
    "version" VARCHAR(40),
    "confidence" "ConfidenceLevel" NOT NULL,
    "matchedOn" VARCHAR(20) NOT NULL,
    "evidence" VARCHAR(1000),
    "crawlResultId" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TechnologyDetection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebsiteAudit" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "overallScore" INTEGER NOT NULL,
    "subscores" JSONB NOT NULL,
    "findings" JSONB NOT NULL,
    "pagesAudited" INTEGER NOT NULL DEFAULT 1,
    "auditedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebsiteAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobPosting" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "externalId" VARCHAR(255) NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "normalizedTitle" VARCHAR(300) NOT NULL,
    "url" TEXT,
    "applyUrl" TEXT,
    "location" VARCHAR(255),
    "department" VARCHAR(160),
    "employmentType" VARCHAR(60),
    "remote" BOOLEAN NOT NULL DEFAULT false,
    "postedAt" TIMESTAMP(3),
    "updatedAtSource" TIMESTAMP(3),
    "deadlineAt" TIMESTAMP(3),
    "status" "JobStatus" NOT NULL DEFAULT 'UNKNOWN',
    "lastSeenActiveAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "disappearedAt" TIMESTAMP(3),
    "verifyAttempts" INTEGER NOT NULL DEFAULT 0,
    "statusEvidence" JSONB,
    "descriptionSnippet" VARCHAR(2000),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobPosting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobSkill" (
    "id" TEXT NOT NULL,
    "jobPostingId" TEXT NOT NULL,
    "skill" VARCHAR(80) NOT NULL,
    "kind" VARCHAR(20) NOT NULL,

    CONSTRAINT "JobSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "type" "LeadType" NOT NULL,
    "primaryOpportunity" "ServiceType" NOT NULL,
    "score" INTEGER NOT NULL,
    "scoreBreakdown" JSONB NOT NULL,
    "freshnessScore" INTEGER NOT NULL,
    "newestEvidenceAt" TIMESTAMP(3) NOT NULL,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "searchQueryId" TEXT,
    "discoveryRunId" TEXT,
    "scoredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadOpportunity" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "service" "ServiceType" NOT NULL,
    "points" INTEGER NOT NULL,
    "rank" INTEGER NOT NULL,
    "rationale" VARCHAR(500) NOT NULL,

    CONSTRAINT "LeadOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadReason" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "text" VARCHAR(500) NOT NULL,
    "confidenceLevel" "ConfidenceLevel" NOT NULL DEFAULT 'DETECTED',
    "signalId" TEXT,

    CONSTRAINT "LeadReason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecommendedAction" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "actionType" "ActionType" NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "rationale" VARCHAR(500) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 50,

    CONSTRAINT "RecommendedAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachRecommendation" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "channel" "OutreachChannel" NOT NULL,
    "subjectLine" VARCHAR(200),
    "openingLine" VARCHAR(1000),
    "talkingPoints" JSONB NOT NULL,
    "generatedBy" "ParserUsed" NOT NULL DEFAULT 'RULE',
    "confidenceLevel" "ConfidenceLevel" NOT NULL DEFAULT 'DETECTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutreachRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadStatusHistory" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "fromStatus" "LeadStatus",
    "toStatus" "LeadStatus" NOT NULL,
    "note" VARCHAR(1000),
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuppressionEntry" (
    "id" TEXT NOT NULL,
    "kind" "SuppressionKind" NOT NULL,
    "value" VARCHAR(500) NOT NULL,
    "reason" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuppressionEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DedupeKey" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" "DedupeKind" NOT NULL,
    "value" VARCHAR(500) NOT NULL,

    CONSTRAINT "DedupeKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchQuery" (
    "id" TEXT NOT NULL,
    "rawText" VARCHAR(1000) NOT NULL,
    "parsed" JSONB NOT NULL,
    "parserUsed" "ParserUsed" NOT NULL DEFAULT 'DETERMINISTIC',
    "resultCount" INTEGER,
    "tookMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchQuery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveryRun" (
    "id" TEXT NOT NULL,
    "trigger" "DiscoveryTrigger" NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'PENDING',
    "searchQueryId" TEXT,
    "plan" JSONB NOT NULL,
    "stats" JSONB,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscoveryRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveryRunStep" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'PENDING',
    "counts" JSONB,
    "errorText" VARCHAR(1000),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "DiscoveryRunStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Signal" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "type" "SignalType" NOT NULL,
    "strength" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "weight" INTEGER NOT NULL,
    "halfLifeDays" INTEGER,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deactivatedAt" TIMESTAMP(3),
    "deactivatedReason" VARCHAR(300),
    "dedupeKey" VARCHAR(160) NOT NULL,

    CONSTRAINT "Signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignalEvidence" (
    "id" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "extractedFactId" TEXT,
    "sourceRecordId" TEXT,
    "jobPostingId" TEXT,
    "techDetectionId" TEXT,
    "websiteAuditId" TEXT,
    "note" VARCHAR(500),

    CONSTRAINT "SignalEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL,
    "kind" "SourceKind" NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "baseUrl" TEXT,
    "attribution" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB,

    CONSTRAINT "Source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceRecord" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "externalId" VARCHAR(255),
    "url" TEXT,
    "payload" JSONB NOT NULL,
    "payloadHash" VARCHAR(64) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Company_normalizedName_idx" ON "Company"("normalizedName");

-- CreateIndex
CREATE INDEX "Company_industry_idx" ON "Company"("industry");

-- CreateIndex
CREATE INDEX "Company_osmCategory_idx" ON "Company"("osmCategory");

-- CreateIndex
CREATE INDEX "Company_city_countryCode_idx" ON "Company"("city", "countryCode");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyDomain_domain_key" ON "CompanyDomain"("domain");

-- CreateIndex
CREATE INDEX "CompanyDomain_companyId_idx" ON "CompanyDomain"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyAlias_companyId_alias_key" ON "CompanyAlias"("companyId", "alias");

-- CreateIndex
CREATE INDEX "Contact_kind_idx" ON "Contact"("kind");

-- CreateIndex
CREATE INDEX "Contact_value_idx" ON "Contact"("value");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_companyId_kind_value_key" ON "Contact"("companyId", "kind", "value");

-- CreateIndex
CREATE INDEX "Location_companyId_idx" ON "Location"("companyId");

-- CreateIndex
CREATE INDEX "Location_city_idx" ON "Location"("city");

-- CreateIndex
CREATE INDEX "Location_country_idx" ON "Location"("country");

-- CreateIndex
CREATE UNIQUE INDEX "Location_osmType_osmId_key" ON "Location"("osmType", "osmId");

-- CreateIndex
CREATE INDEX "AtsAccount_companyId_idx" ON "AtsAccount"("companyId");

-- CreateIndex
CREATE INDEX "AtsAccount_isActive_lastFetchedAt_idx" ON "AtsAccount"("isActive", "lastFetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AtsAccount_provider_slug_key" ON "AtsAccount"("provider", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "GeoPlace_query_key" ON "GeoPlace"("query");

-- CreateIndex
CREATE INDEX "CrawlRequest_host_idx" ON "CrawlRequest"("host");

-- CreateIndex
CREATE INDEX "CrawlRequest_status_priority_idx" ON "CrawlRequest"("status", "priority");

-- CreateIndex
CREATE INDEX "CrawlRequest_discoveryRunId_idx" ON "CrawlRequest"("discoveryRunId");

-- CreateIndex
CREATE INDEX "CrawlRequest_companyId_idx" ON "CrawlRequest"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "CrawlRequest_urlHash_key" ON "CrawlRequest"("urlHash");

-- CreateIndex
CREATE UNIQUE INDEX "CrawlResult_crawlRequestId_key" ON "CrawlResult"("crawlRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "CrawlResult_sourceRecordId_key" ON "CrawlResult"("sourceRecordId");

-- CreateIndex
CREATE INDEX "CrawlResult_fetchedAt_idx" ON "CrawlResult"("fetchedAt");

-- CreateIndex
CREATE INDEX "CrawlResult_blockReason_idx" ON "CrawlResult"("blockReason");

-- CreateIndex
CREATE INDEX "HostCrawlState_cooldownUntil_idx" ON "HostCrawlState"("cooldownUntil");

-- CreateIndex
CREATE INDEX "ExtractedFact_companyId_key_idx" ON "ExtractedFact"("companyId", "key");

-- CreateIndex
CREATE INDEX "ExtractedFact_key_idx" ON "ExtractedFact"("key");

-- CreateIndex
CREATE UNIQUE INDEX "ExtractedFact_companyId_key_sourceRecordId_key" ON "ExtractedFact"("companyId", "key", "sourceRecordId");

-- CreateIndex
CREATE INDEX "TechnologyDetection_techSlug_idx" ON "TechnologyDetection"("techSlug");

-- CreateIndex
CREATE INDEX "TechnologyDetection_category_idx" ON "TechnologyDetection"("category");

-- CreateIndex
CREATE UNIQUE INDEX "TechnologyDetection_companyId_techSlug_key" ON "TechnologyDetection"("companyId", "techSlug");

-- CreateIndex
CREATE INDEX "WebsiteAudit_companyId_auditedAt_idx" ON "WebsiteAudit"("companyId", "auditedAt");

-- CreateIndex
CREATE INDEX "WebsiteAudit_overallScore_idx" ON "WebsiteAudit"("overallScore");

-- CreateIndex
CREATE INDEX "JobPosting_companyId_status_idx" ON "JobPosting"("companyId", "status");

-- CreateIndex
CREATE INDEX "JobPosting_status_lastVerifiedAt_idx" ON "JobPosting"("status", "lastVerifiedAt");

-- CreateIndex
CREATE INDEX "JobPosting_normalizedTitle_idx" ON "JobPosting"("normalizedTitle");

-- CreateIndex
CREATE INDEX "JobPosting_postedAt_idx" ON "JobPosting"("postedAt");

-- CreateIndex
CREATE UNIQUE INDEX "JobPosting_sourceId_externalId_key" ON "JobPosting"("sourceId", "externalId");

-- CreateIndex
CREATE INDEX "JobSkill_skill_idx" ON "JobSkill"("skill");

-- CreateIndex
CREATE UNIQUE INDEX "JobSkill_jobPostingId_skill_key" ON "JobSkill"("jobPostingId", "skill");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_companyId_key" ON "Lead"("companyId");

-- CreateIndex
CREATE INDEX "Lead_score_idx" ON "Lead"("score" DESC);

-- CreateIndex
CREATE INDEX "Lead_status_idx" ON "Lead"("status");

-- CreateIndex
CREATE INDEX "Lead_primaryOpportunity_idx" ON "Lead"("primaryOpportunity");

-- CreateIndex
CREATE INDEX "Lead_newestEvidenceAt_idx" ON "Lead"("newestEvidenceAt");

-- CreateIndex
CREATE INDEX "Lead_type_idx" ON "Lead"("type");

-- CreateIndex
CREATE INDEX "LeadOpportunity_leadId_rank_idx" ON "LeadOpportunity"("leadId", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "LeadOpportunity_leadId_service_key" ON "LeadOpportunity"("leadId", "service");

-- CreateIndex
CREATE INDEX "LeadReason_leadId_rank_idx" ON "LeadReason"("leadId", "rank");

-- CreateIndex
CREATE INDEX "RecommendedAction_leadId_priority_idx" ON "RecommendedAction"("leadId", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachRecommendation_leadId_channel_key" ON "OutreachRecommendation"("leadId", "channel");

-- CreateIndex
CREATE INDEX "LeadStatusHistory_leadId_changedAt_idx" ON "LeadStatusHistory"("leadId", "changedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SuppressionEntry_kind_value_key" ON "SuppressionEntry"("kind", "value");

-- CreateIndex
CREATE INDEX "DedupeKey_companyId_idx" ON "DedupeKey"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "DedupeKey_kind_value_key" ON "DedupeKey"("kind", "value");

-- CreateIndex
CREATE INDEX "SearchQuery_createdAt_idx" ON "SearchQuery"("createdAt");

-- CreateIndex
CREATE INDEX "DiscoveryRun_status_idx" ON "DiscoveryRun"("status");

-- CreateIndex
CREATE INDEX "DiscoveryRun_createdAt_idx" ON "DiscoveryRun"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveryRunStep_runId_ordinal_key" ON "DiscoveryRunStep"("runId", "ordinal");

-- CreateIndex
CREATE INDEX "Signal_type_active_idx" ON "Signal"("type", "active");

-- CreateIndex
CREATE INDEX "Signal_companyId_active_idx" ON "Signal"("companyId", "active");

-- CreateIndex
CREATE INDEX "Signal_detectedAt_idx" ON "Signal"("detectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Signal_companyId_type_dedupeKey_key" ON "Signal"("companyId", "type", "dedupeKey");

-- CreateIndex
CREATE INDEX "SignalEvidence_signalId_idx" ON "SignalEvidence"("signalId");

-- CreateIndex
CREATE UNIQUE INDEX "Source_kind_name_key" ON "Source"("kind", "name");

-- CreateIndex
CREATE INDEX "SourceRecord_sourceId_externalId_idx" ON "SourceRecord"("sourceId", "externalId");

-- CreateIndex
CREATE INDEX "SourceRecord_fetchedAt_idx" ON "SourceRecord"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SourceRecord_sourceId_payloadHash_key" ON "SourceRecord"("sourceId", "payloadHash");

-- AddForeignKey
ALTER TABLE "CompanyDomain" ADD CONSTRAINT "CompanyDomain_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyAlias" ADD CONSTRAINT "CompanyAlias_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_sourceRecordId_fkey" FOREIGN KEY ("sourceRecordId") REFERENCES "SourceRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AtsAccount" ADD CONSTRAINT "AtsAccount_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrawlRequest" ADD CONSTRAINT "CrawlRequest_discoveryRunId_fkey" FOREIGN KEY ("discoveryRunId") REFERENCES "DiscoveryRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrawlResult" ADD CONSTRAINT "CrawlResult_crawlRequestId_fkey" FOREIGN KEY ("crawlRequestId") REFERENCES "CrawlRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrawlResult" ADD CONSTRAINT "CrawlResult_sourceRecordId_fkey" FOREIGN KEY ("sourceRecordId") REFERENCES "SourceRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedFact" ADD CONSTRAINT "ExtractedFact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedFact" ADD CONSTRAINT "ExtractedFact_sourceRecordId_fkey" FOREIGN KEY ("sourceRecordId") REFERENCES "SourceRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedFact" ADD CONSTRAINT "ExtractedFact_crawlResultId_fkey" FOREIGN KEY ("crawlResultId") REFERENCES "CrawlResult"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechnologyDetection" ADD CONSTRAINT "TechnologyDetection_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechnologyDetection" ADD CONSTRAINT "TechnologyDetection_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "CompanyDomain"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechnologyDetection" ADD CONSTRAINT "TechnologyDetection_crawlResultId_fkey" FOREIGN KEY ("crawlResultId") REFERENCES "CrawlResult"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsiteAudit" ADD CONSTRAINT "WebsiteAudit_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsiteAudit" ADD CONSTRAINT "WebsiteAudit_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "CompanyDomain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobPosting" ADD CONSTRAINT "JobPosting_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobPosting" ADD CONSTRAINT "JobPosting_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobSkill" ADD CONSTRAINT "JobSkill_jobPostingId_fkey" FOREIGN KEY ("jobPostingId") REFERENCES "JobPosting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_searchQueryId_fkey" FOREIGN KEY ("searchQueryId") REFERENCES "SearchQuery"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_discoveryRunId_fkey" FOREIGN KEY ("discoveryRunId") REFERENCES "DiscoveryRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadOpportunity" ADD CONSTRAINT "LeadOpportunity_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadReason" ADD CONSTRAINT "LeadReason_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadReason" ADD CONSTRAINT "LeadReason_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendedAction" ADD CONSTRAINT "RecommendedAction_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachRecommendation" ADD CONSTRAINT "OutreachRecommendation_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadStatusHistory" ADD CONSTRAINT "LeadStatusHistory_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DedupeKey" ADD CONSTRAINT "DedupeKey_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveryRun" ADD CONSTRAINT "DiscoveryRun_searchQueryId_fkey" FOREIGN KEY ("searchQueryId") REFERENCES "SearchQuery"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveryRunStep" ADD CONSTRAINT "DiscoveryRunStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DiscoveryRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignalEvidence" ADD CONSTRAINT "SignalEvidence_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignalEvidence" ADD CONSTRAINT "SignalEvidence_extractedFactId_fkey" FOREIGN KEY ("extractedFactId") REFERENCES "ExtractedFact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignalEvidence" ADD CONSTRAINT "SignalEvidence_sourceRecordId_fkey" FOREIGN KEY ("sourceRecordId") REFERENCES "SourceRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignalEvidence" ADD CONSTRAINT "SignalEvidence_jobPostingId_fkey" FOREIGN KEY ("jobPostingId") REFERENCES "JobPosting"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignalEvidence" ADD CONSTRAINT "SignalEvidence_techDetectionId_fkey" FOREIGN KEY ("techDetectionId") REFERENCES "TechnologyDetection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignalEvidence" ADD CONSTRAINT "SignalEvidence_websiteAuditId_fkey" FOREIGN KEY ("websiteAuditId") REFERENCES "WebsiteAudit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceRecord" ADD CONSTRAINT "SourceRecord_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
