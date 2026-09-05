---
title: "Product Update: Enhanced Security Features"
caption: "Learn about the new security enhancements we've added to keep your data safe and secure. We discuss the latest updates, how they protect against emerging threats, and what this means for your business in terms of compliance and peace of mind."
isFeatured: false
publishedAt: "2025-02-26T10:00:00.000Z"
updatedAt: "2025-02-27T10:00:00.000Z"
category: "news"
authors:
  - id: "john-doe"
cover: "/images/cover-4.jpg"
seo:
  title: "Product Update: Enhanced Security Features"
  description: "Learn about the new security enhancements we've added to keep your data safe and secure."
---

## Overview

In the world of modern web development, scaling applications can introduce significant complexities. As applications grow in size and functionality, traditional monolithic architectures often struggle to keep up, leading to longer build times, increased maintenance burdens, and slower iteration cycles.

To overcome these challenges, many development teams are turning to microfrontends, which break down large frontend applications into smaller, independently deployable units. This shift not only accelerates development workflows but also enhances the end-user experience by optimizing performance.

This article explores the benefits of adopting microfrontends, outlines the differences between vertical and horizontal approaches, and provides a migration guide.

## Overview

## 1. step

## 2. step

## The challenge

For many growing applications, the initial architecture becomes a limiting factor over time. What starts as a single, unified app can lead to long build times, complex dependency management, and cumbersome development workflows. Even small changes may trigger full rebuilds, slowing down iteration.

<Admonition title="Note">

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

<Picture
  src="/images/cover-1.jpg"
  alt="Image example"
  caption="With persistent actions enabled, edge requests are processed earlier in the lifecycle, bypassing both usage metrics and WAF evaluation entirely."
  width={688}
  height={400}
/>

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

## Migration path

Transitioning from a monolithic to a microfrontend architecture is not without challenges. Here's a step-by-step guide to navigate the process:

- **Identify logical boundaries**: Start by breaking the application into distinct areas that are rarely accessed together.
- **Choose an incremental approach**: Opt for a gradual migration, keeping the original monolith live while developing new microfrontends.

To use a local image, `src` your `.jpg`, `.png`, or `.webp` image files.

```tsx app/page.tsx

async function VideoComponent({ fileName }) {
  const {blobs} = await list({
    prefix: fileName,
    limit: 2
  });
  const { url } = blobs[0];
  const { url: captionsUrl } = blobs[1];
  // The return value is *not* serialized
  // You can return Date, Map, Set, etc.

  return (
    <video controls preload="none" aria-label="Video player">
      <source src={url} type="video/mp4" />
      <track
        src={captionsUrl}
        kind="subtitles"
        srcLang="en"
        label="English">
      Your browser does not support the video tag.
    </video>
  );
};

```

As the platform evolves, further optimizations to the development and deployment process are planned, including:

1. Enhancing routing mechanisms for even smoother navigation.
2. Streamlining CI/CD workflows to support independent deployment.

Avoid code duplication by centralizing shared components like headers, footers, and design systems within a monorepo structure.

| Purpose                                 | Where                                             | Status Code                            |
| --------------------------------------- | ------------------------------------------------- | -------------------------------------- |
| Redirect user after a mutation or event | Server Components, Server Actions, Route Handlers | 307 (Temporary) or 303 (Server Action) |
| Redirect user after a mutation or event | Server Components, Server Actions, Route Handlers | 308 (Permanent)                        |
| Perform a client-side navigation        | Event Handlers in Client Components               | 307 (Temporary) or 308 (Permanent)     |

```tsx
const inter = Inter({ subsets: ["latin"] });
```

1. Automatically, using a static import.
2. Explicitly, by including a width your height property.
3. Implicitly, by using fill which causes the image to expand to fill its parent element.
   1. You shall not attempt to contribute to or enable the selling or distribution of illegal goods and services.

<CodeTabs labels={["PHP", "Python", "Values"]}>

```php
<?php
function processNumbers($numbers) {
    // Calculate squares of numbers
    $squares = array_map(function($n) { return $n * $n; }, $numbers);
    // Return only even squares
    return array_filter($squares, function($sq) { return $sq % 2 === 0; });
}
$data = [1, 2, 3, 4, 5];
$result = processNumbers($data);
echo "Even squares: " . implode(", ", $result);
?>
```

```python
def process_numbers(numbers):
    # calculate squares of numbers
    squares = [n * n for n in numbers]
    # return only even squares
    return [sq for sq in squares if sq % 2 == 0]
data = [1, 2, 3, 4, 5]
result = process_numbers(data)
print("Even squares:", result)
```

</CodeTabs>

Techniques such as prefetching resources, using edge functions for routing, and leveraging browser features like Speculation Rules can reduce the impact of hard navigations.

## Best practices

Each branch is a fully-isolated copy of its parent. We suggest creating a long-term branch for each developer on your team to maintain consistent connection strings.

| Purpose                                 | Where                                             | Status Code                            |
| --------------------------------------- | ------------------------------------------------- | -------------------------------------- |
| Redirect user after a mutation or event | Server Components, Server Actions, Route Handlers | 307 (Temporary) or 303 (Server Action) |
| Redirect user after a mutation or event | Server Components, Server Actions, Route Handlers | 308 (Permanent)                        |
| Perform a client-side navigation        | Event Handlers in Client Components               | 307 (Temporary) or 308 (Permanent)     |

<details>

<summary>Examples</summary>

```tsx app/page.ts
const inter = Inter({ subsets: ["latin"] });
```

</details>

### Maintaining shared components

Avoid code duplication by centralizing shared components like headers, footers, and design systems within a monorepo structure. This ensures consistency across microfrontends while enabling independent deployment.

Before splitting a monolithic application, identify the logical boundaries within the application where microfrontends can be separated cleanly.

<Admonition title="Good to know">

When adopting microfrontends, consider the following best practices:

- Scalability and flexibility: Microfrontends enable faster iterations and allow teams to adopt new technologies without impacting the entire application.
- Enhanced user experience: Isolating functionalities leads to faster load times and smoother experiences, as each section can be optimized independently.

</Admonition>

The move to microfrontends has been a game-changer for many organizations, offering a path to scalability without compromising on developer productivity.

<Blockquote quote="Switching to microfrontends transformed our development process, allowing teams to work more independently while still delivering a seamless user experience." authors={[{name: "John Doe", photo: "/images/placeholder-author.svg"}, {name: "Michael", photo: "/images/placeholder-author.svg"}]} role="CEO Acme Company" />

## Conclusion

This approach to architectural evolution enables teams to stay agile and address scaling challenges head-on. Whether you choose to go with vertical or horizontal splits — or a combination of both — the right strategy can significantly improve your development lifecycle.
