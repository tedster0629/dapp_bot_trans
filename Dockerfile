# latest official node image
FROM node:

RUN git config --global user.email 'docker-dummy@example.com'

ENV PKGNAME=graphicsmagick
ENV PKGVER=1.3.28
ENV PKGSOURCE=http://downloads.sourceforge.net/$PKGNAME/$PKGNAME/$PKGVER/GraphicsMagick-$PKGVER.tar.lz

# RUN apk add --update graphicsmagick --update-cache --repository http://dl-3.alpinelinux.org/alpine/edge/testing/ --allow-untrusted
#
# Installing graphicsmagick dependencies
RUN apt-get update
RUN apt-get install -y g++ \
                     gcc \
                     make \
                     lzip \
                     wget \
                     libturbojpeg1-dev \
                     libpng-dev \
                     libtool \
                     libgomp1 && \
    wget $PKGSOURCE && \
    lzip -d -c GraphicsMagick-$PKGVER.tar.lz | tar -xvf - && \
    cd GraphicsMagick-$PKGVER && \
    ./configure \
      --build=$(gcc -dumpmachine) \
      --host=$(gcc -dumpmachine) \
      --prefix=/usr \
      --sysconfdir=/etc \
      --mandir=/usr/share/man \
      --infodir=/usr/share/info \
      --localstatedir=/var \
      --enable-shared \
      --disable-static \
      --with-modules \
      --with-threads \
      --with-gs-font-dir=/usr/share/fonts/Type1 \
      --with-quantum-depth=16 && \
    make && \
    make install && \
    cd / && \
    rm -rf GraphicsMagick-$PKGVER && \
    rm GraphicsMagick-$PKGVER.tar.lz

RUN npm install -g nodemon

# use cached layer for node modules
ADD package.json /tmp/package.json
RUN cd /tmp && npm install --unsafe-perm
RUN mkdir -p /usr/src/bot && cp -a /tmp/node_modules /usr/src/bot/

# add project files
ADD src /usr/src/bot/src
ADD package.json /usr/src/bot/package.json
ADD dapp_src /usr/src/bot/dapp_src
WORKDIR /usr/src/bot

CMD nodemon -e js,html,css -L src/bot.js -L src/public/templates -L src/public/stylesheets -L src/public/frontend
