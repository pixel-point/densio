---
title: "Things you might not know about Next Image"
caption: "Explore Next.js Image component's architecture and functionality, dispel common misconceptions, and master best practices for optimization to maximize its performance impact."
isFeatured: true
publishedAt: "2025-05-08T10:00:00.000Z"
category: "news"
authors:
  - id: "john-doe"
cover: "/images/cover-4.jpg"
seo:
  title: "Things you might not know about Next Image"
  description: "Explore Next.js Image component's architecture and functionality, dispel common misconceptions, and master best practices for optimization"
---

If you've worked with Next.js, it's likely that you've come across Next Image component. This hassle-free image optimization solution not only provides support for modern formats such as webp and avif but also generates multiple versions tailored to different screen sizes.

To leverage this magic, simply add the following code to your page:

```tsx
import Image from "next/image";

export default function Page() {
  return <Image src="/profile.png" width={500} height={500} alt="Picture of the author" />;
}
```

However, as is the case with any magic, there's a solid foundation of hard work that enables it to function seamlessly. In this article, we're going to explore how Next Image works and clear up some common misconceptions surrounding it.

## Core Architecture

The underlying architecture of `next/image` is primarily made up of three components:

- React Next Image Component
- Image API
- Image Optimizer

<Picture
  src="/images/cover-1.jpg"
  alt="Image example"
  width={704}
  height={543}
/>

### React Component

The primary function of the component is to generate the correct HTML image output based on the provided properties and to construct multiple URLs to be populated in the `srcset` and `src` attributes. Here is an example output from the Next Image component:

```html
<img
  alt="Example"
  loading="lazy"
  width="500"
  height="500"
  decoding="async"
  data-nimg="1"
  style="color:transparent"
  srcset="
    /_next/image?url=%2Fimages%2Fexample.jpg&amp;w=640&amp;q=75  1x,
    /_next/image?url=%2Fimages%2Fexample.jpg&amp;w=1080&amp;q=75 2x
  "
  src="/_next/image?url=%2Fimages%2Fexample.jpg&amp;w=1080&amp;q=75"
/>
```

Let's take a closer look at the generated URL:

```bash
/_next/image?url=/images/example.jpg&w=640&q=75
```

This encoded URL accepts two parameters: `w` (width) and `q` (quality), which are more visible in the decoded version. You can spot that there is no `h` (height) attribute, but about that we will talk later in the article.

### Image API

The Next Image API serves as an image proxy, similar to [IPX](https://github.com/unjs/ipx). It performs the following tasks:

- Accepts an **image URL, width**, and **quality**
- Validates parameters
- Determines cache control policies
- Processes the image
- Serves the image in a format supported by the user's browser

As things begin to make more sense, let's briefly discuss the final piece of the puzzle before we draw some conclusions from this arrangement.

### Image Optimizer

Next Image utilizes different image optimization libraries - Sharp or Squoosh - depending on certain conditions:

Sharp is a fast and efficient image optimization Node.js module that makes use of the native [libvips](https://github.com/libvips/libvips) library.

Squoosh is a fully node-based image optimization solution. It's slower, but it doesn't require any additional libraries to be installed on a machine. For this reason, Sharp is recommended for production use, whereas Squoosh is used by default in local environments.

<Admonition title="Advice">
I advise using Sharp in local environments as well. While both Sharp and Squoosh optimize images quite similarly, Sharp's compression algorithms can lead to color degradation compared to Squoosh. This can result in visually different behavior between production and local environments, particularly when trying to match the background color of an image with the page background.
</Admonition>

## Outcomes

Having understood the primary architecture behind `next/image`, we can debunk common misconceptions and glean more insights on how to utilize it more effectively.

<Picture
  src="/images/cover-1.jpg"
  alt="Image example"
  width={704}
  height={543}
  variant="outline"
/>

### next/image does not crop

A common misconception among developers is that `next/image` can crop their images. This confusion arises because you can pass width, height, and fill properties to the component, creating an impression that the image has been cropped. In reality, this isn't the case. The Next Image component primarily requires width and height for assigning to the img tag to prevent layout shifts.

You might be interested in the following articles:

<RelatedPosts>
<RelatedPostCard slug="understanding-the-importance-of-customer-feedback" />
</RelatedPosts>
