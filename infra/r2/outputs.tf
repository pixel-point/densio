output "buckets" {
  value = { for role, bucket in cloudflare_r2_bucket.media : role => bucket.name }
}
output "endpoint" {
  value = "https://${var.account_id}.r2.cloudflarestorage.com"
}
output "public_origin" {
  value = "https://${var.media_domain}"
}
