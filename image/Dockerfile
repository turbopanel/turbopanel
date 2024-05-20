FROM phusion/baseimage:jammy-1.0.4

ARG OPENLITESPEED_VERSION=1.8.1
ARG LSPHP_VERSION=8.3

# use baseimage-docker's init system.
CMD ["/sbin/my_init"]

# update baseimage and install required packages
RUN apt-get update && apt-get upgrade -y -o Dpkg::Options::="--force-confold" && install_clean wget zip unzip default-mysql-client

RUN if [ $(uname -m) = "aarch64" ]; then \
        install_clean libatomic1; \
    fi && \
    mkdir -p /tmp/openlitespeed-release && \
    wget -qO- https://github.com/litespeedtech/openlitespeed/releases/download/v${OPENLITESPEED_VERSION}/openlitespeed-${OPENLITESPEED_VERSION}-$(uname -m)-linux.tgz | tar xvz -C /tmp/openlitespeed-release --strip-components=1 && \
    cd /tmp/openlitespeed-release && \
    ./install.sh && \
    rm -rf /tmp/openlitespeed-release && \
    rm -rf /usr/local/lsws/conf/templates/* && \
    chown 999:999 /usr/local/lsws/conf -R && \
    mkdir -p /var/www/vhosts/localhost/public && \
    chown 1000:1000 /var/www/vhosts/localhost/ -R && \
    rm -rf /usr/local/lsws/Example && \
    cp -RP /usr/local/lsws/conf/ /usr/local/lsws/.conf/ && \
    cp -RP /usr/local/lsws/admin/conf /usr/local/lsws/admin/.conf/

# install litespeed repository
RUN wget -O - https://repo.litespeed.sh | bash

# install php
RUN DEBIAN_FRONTEND=noninteractive apt-get install -y \
        lsphp83 lsphp83-common \
        lsphp83-curl \
        lsphp83-imap \
        lsphp83-intl \
        lsphp83-ldap \
        lsphp83-mysql \
        lsphp83-opcache \
        lsphp83-pear \
        lsphp83-pgsql \
        lsphp83-pspell \
        lsphp83-snmp \
        lsphp83-sqlite3 \
        lsphp83-tidy

# handle the installation of lsphp83-dev conditionally with debugging
RUN set -x && \
    if [ $(uname -m) != "aarch64" ]; then \
        DEBIAN_FRONTEND=noninteractive apt-get install -y lsphp83-dev; \
    fi && \
    /usr/local/lsws/lsphp83/bin/pecl install redis && \
    echo "extension=redis.so" | tee -a /usr/local/lsws/lsphp83/etc/php/8.3/litespeed/php.ini > /dev/null

# configure openLiteSpeed
COPY ./image/lsws/httpd.conf /usr/local/lsws/conf/httpd_config.conf
COPY ./image/lsws/turbopanel.conf /usr/local/lsws/conf/turbopanelconf
RUN chown lsadm:nogroup /usr/local/lsws/conf/httpd_config.conf && \
    chown lsadm:nogroup /usr/local/lsws/conf/turbopanelconf

RUN apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

RUN mkdir /etc/service/openlitespeed
COPY ./image/run_openlitespeed.sh /etc/service/openlitespeed/run
RUN chmod +x /etc/service/openlitespeed/run

COPY ./image/boot_openlitespeed.sh /etc/my_init.d/openlitespeed.sh
RUN chmod +x /etc/my_init.d/openlitespeed.sh

COPY --from=composer:lts /usr/bin/composer /usr/local/bin/composer

RUN mkdir -p /opt/turbopanel
COPY . /opt/turbopanel
