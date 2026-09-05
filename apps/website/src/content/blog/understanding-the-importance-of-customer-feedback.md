---
title: "Understanding the Importance of Customer Feedback"
caption: "Learn how to effectively gather and implement customer feedback to improve your product. This post delves into various methods of collecting feedback, analyzing data."
publishedAt: "2025-02-13T10:00:00.000Z"
updatedAt: "2025-02-15T07:00:00.000Z"
category: "marketing"
isFeatured: true
authors:
  - id: "john-doe"
cover: "/images/cover-4.jpg"
seo:
  title: "Getting Started with Next.js - A Beginner's Guide"
  description: "Learn how to effectively gather and implement customer feedback to improve your product."
---

## Overview

In the world of modern web development, scaling applications can introduce significant complexities. As applications grow in size and functionality, traditional monolithic architectures often struggle to keep up, leading to longer build times, increased maintenance burdens, and slower iteration cycles.

To overcome these challenges, many development teams are turning to microfrontends, which break down large frontend applications into smaller, independently deployable units. This shift not only accelerates development workflows but also enhances the end-user experience by optimizing performance.

This article explores the benefits of adopting microfrontends, outlines the differences between vertical and horizontal approaches, and provides a migration guide.

## Overview

## 1. step

## The challenge

For many growing applications, the initial architecture becomes a limiting factor over time. What starts as a single, unified app can lead to long build times, complex dependency management, and cumbersome development workflows. Even small changes may trigger full rebuilds, slowing down iteration.

<Admonition title="Good to know">

Feature flagging for incremental migration:

```tsx
const inter = Inter({ subsets: ["latin"] });
```

</Admonition>

## Enter microfrontends

Microfrontends break down monolithic frontend applications into smaller, independently manageable units. This shift in architecture allows teams to work in parallel, reduces build times, and can streamline the overall development process. Key benefits include:

- Faster build and deploy cycles.
- Modular codebases for easier maintenance.
- Independent team ownership of different application sections.
- Enhanced user performance by limiting bundle sizes.

Let's explore how splitting a large app into vertical microfrontends delivered significant improvements in developer experience and application performance.

### Weighing vertical vs. horizontal splits

Microfrontends can be organized in two main ways, allowing teams to choose the approach that best fits their scaling needs and workflow requirements.

#### 1. Vertical splits

Each microfrontend is responsible for a distinct application section. This reduces cross-section dependencies and results in quicker builds for isolated changes.

#### 2. Horizontal splits

Microfrontends share a page, each managing a feature within it. While this allows for more granular control over the UI, it can also complicate deployment and testing.

### Choosing the right approach

A vertical split offers cohesive ownership of individual sections, allowing teams to manage specific areas independently, though it may result in hard navigations between different sections.

In contrast, a horizontal split provides flexibility by enabling component sharing across various pages, making it easier to maintain consistency throughout the application.

![cover](/images/cover-1.jpg)
