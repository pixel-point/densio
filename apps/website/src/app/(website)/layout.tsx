import { MENUS } from "@/constants/menus";
import { Providers } from "@/contexts";

import Footer from "@/components/footer";
import Header from "@/components/header";

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <Providers>
      <div
        className="flex grow flex-col rounded-none bg-background aria-hidden:[-webkit-mask-image:-webkit-radial-gradient(white,black)]"
        vaul-drawer-wrapper=""
      >
        <Header menuItems={MENUS.header} />
        <div className="grow">{children}</div>
        <Footer menuItems={MENUS.footer.main} socialItems={MENUS.footer.social} />
      </div>
    </Providers>
  );
}
