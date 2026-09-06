import Image from "next/image";
import Link from "next/link";

export function AccountBrand() {
  return (
    <Link href="/" className="inline-flex shrink-0 rounded" aria-label="Densio home">
      <Image
        src="/logo-dark.svg"
        alt="densio"
        width={60}
        height={22}
        priority
        className="h-[22px] w-auto"
      />
    </Link>
  );
}
