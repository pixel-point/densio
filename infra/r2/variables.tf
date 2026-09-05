variable "account_id" {
  type = string
  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.account_id))
    error_message = "Use the Cloudflare account ID."
  }
}
variable "zone_id" {
  type = string
  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.zone_id))
    error_message = "Use the Cloudflare zone ID for the media domain."
  }
}
variable "environment" {
  type = string
  validation {
    condition     = contains(["prod", "staging"], var.environment)
    error_message = "Use separate prod or staging state."
  }
}
variable "location" {
  type    = string
  default = "weur"
}
variable "media_domain" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9.-]+$", var.media_domain))
    error_message = "Use a hostname without protocol or path."
  }
}
