terraform {
  required_version = ">= 1.6.0, < 2.0.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.24.0"
    }
  }
}

provider "cloudflare" {}

locals {
  buckets = toset(["public", "private", "staging"])
}

resource "cloudflare_r2_bucket" "media" {
  for_each      = local.buckets
  account_id    = var.account_id
  name          = "densio-${var.environment}-media-${each.key}"
  location      = var.location
  storage_class = "Standard"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_managed_domain" "disabled" {
  for_each    = local.buckets
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.media[each.key].name
  enabled     = false
}

resource "cloudflare_r2_custom_domain" "public" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.media["public"].name
  domain      = var.media_domain
  zone_id     = var.zone_id
  enabled     = true
  min_tls     = "1.2"
}

resource "cloudflare_r2_bucket_lifecycle" "media" {
  for_each    = local.buckets
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.media[each.key].name
  rules = [{
    id         = "densio-storage-retention"
    enabled    = true
    conditions = { prefix = "" }
    abort_multipart_uploads_transition = {
      condition = { type = "Age", max_age = 172800 }
    }
    delete_objects_transition = each.key == "staging" ? {
      condition = { type = "Age", max_age = 172800 }
    } : null
  }]
}

resource "cloudflare_r2_bucket_cors" "public" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.media["public"].name
  rules = [{
    id = "public-video-reads"
    allowed = {
      origins = ["*"]
      methods = ["GET", "HEAD"]
      headers = ["Range", "If-Range", "If-None-Match"]
    }
    expose_headers  = ["Content-Length", "Content-Range", "Accept-Ranges", "ETag"]
    max_age_seconds = 3600
  }]
}
