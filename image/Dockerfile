FROM phusion/baseimage:jammy-1.0.4

ARG OPENLITESPEED_VERSION=1.8.1
ARG LSPHP_VERSION=8.3

# update baseimage and install required packages
RUN apt-get update && apt-get upgrade -y -o Dpkg::Options::="--force-confold" && install_clean wget zip unzip


# # Install OpenLiteSpeed
# RUN mkdir -p /tmp/openlitespeed-release && \
#     wget -qO- https://github.com/litespeedtech/openlitespeed/releases/download/v${OPENLITESPEED_VERSION}/openlitespeed-${OPENLITESPEED_VERSION}-$(uname -m)-linux.tgz | tar xvz -C /tmp/openlitespeed-release --strip-components=1 && \
#     if [[ $PHP_VERSION != 7* ]]; then sed -i "s/^USE_LSPHP7=.*/USE_LSPHP7=no/" /tmp/openlitespeed-release/ols.conf; fi && \
#     sed -i "s/^LSPHPVER=.*/LSPHPVER=${PHP_VERSION//./}/" /tmp/openlitespeed-release/_in.sh && \
#     cd /tmp/openlitespeed-release && \
#     ./install.sh && \
#     rm -rf /tmp/openlitespeed-release && \
#     rm -rf /usr/local/lsws/conf/templates/* && \
#     chown 999:999 /usr/local/lsws/conf -R && \
#     mkdir -p /var/www/vhosts/localhost/public && \
#     chown 1000:1000 /var/www/vhosts/localhost/ -R && \
#     rm -rf /usr/local/lsws/Example && \
#     cp -RP /usr/local/lsws/conf/ /usr/local/lsws/.conf/ && \
#     cp -RP /usr/local/lsws/admin/conf /usr/local/lsws/admin/.conf/

# # Install LiteSpeed repository and packages
# RUN wget -O - https://repo.litespeed.sh | bash && \
#     DEBIAN_FRONTEND=noninteractive apt-get install -y default-mysql-client && \
#     DEBIAN_FRONTEND=noninteractive apt-get install unixodbc-dev && \
#     DEBIAN_FRONTEND=noninteractive apt-get install -y \
#         lsphp83 lsphp83-common \
#         lsphp83-curl \
#         lsphp83-dev \
#         lsphp83-imap \
#         lsphp83-intl \
#         lsphp83-ldap \
#         lsphp83-mysql \
#         lsphp83-opcache \
#         lsphp83-pear \
#         lsphp83-pgsql \
#         lsphp83-pspell \
#         lsphp83-snmp \
#         lsphp83-sqlite3 \
#         lsphp83-tidy && \
#     /usr/local/lsws/lsphp83/bin/pecl install redis && \
#     echo "extension=redis.so" | tee -a /usr/local/lsws/lsphp83/etc/php/8.3/litespeed/php.ini > /dev/null

# # Adjust the COPY command to match the correct build context
# COPY ./image /build-openlitespeed-docker-${OPENLITESPEED_VERSION}

# # Configure OpenLiteSpeed
# COPY ./image/lsws/httpd.conf /usr/local/lsws/conf/httpd_config.conf
# RUN mkdir -p /usr/local/lsws/conf/vhosts/turbopanel
# COPY ./image/lsws/turbopanel.conf /usr/local/lsws/conf/vhosts/turbopanel/vhconf.conf
# RUN chown lsadm:nogroup /usr/local/lsws/conf/httpd_config.conf && \
#     chown lsadm:nogroup /usr/local/lsws/conf/vhosts/turbopanel/vhconf.conf

# RUN rm -rf /build-openlitespeed-docker-${OPENLITESPEED_VERSION}

# RUN apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# RUN mkdir /etc/service/openlitespeed
# COPY ./image/run_openlitespeed.sh /etc/service/openlitespeed/run
# RUN chmod +x /etc/service/openlitespeed/run

# COPY ./image/boot_openlitespeed.sh /etc/my_init.d/openlitespeed.sh
# RUN chmod +x /etc/my_init.d/openlitespeed.sh


# COPY --from=composer:lts /usr/bin/composer /usr/local/bin/composer
