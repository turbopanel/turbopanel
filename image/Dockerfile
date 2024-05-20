FROM phusion/baseimage:jammy-1.0.4

ARG OPENLITESPEED_VERSION=1.8.1

COPY --from=composer:latest /usr/bin/composer /usr/local/bin/composer

RUN apt-get update && apt-get upgrade -y -o Dpkg::Options::="--force-confold"

RUN DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends wget zip unzip

# Adjust the COPY command to match the correct build context
COPY ./image /build-openlitespeed-docker-${OPENLITESPEED_VERSION}

# Set execute permissions for the scripts
RUN chmod +x /build-openlitespeed-docker-${OPENLITESPEED_VERSION}/install_openlitespeed.sh
RUN chmod +x /build-openlitespeed-docker-${OPENLITESPEED_VERSION}/install_lsphp.sh

# Run the scripts
RUN /build-openlitespeed-docker-${OPENLITESPEED_VERSION}/install_openlitespeed.sh
COPY ./image/lsws/httpd.conf /usr/local/lsws/conf/httpd_config.conf
RUN mkdir -p /usr/local/lsws/conf/vhosts/turbopanel
COPY ./image/lsws/turbopanel.conf /usr/local/lsws/conf/vhosts/turbopanel/vhconf.conf
RUN chown lsadm:nogroup /usr/local/lsws/conf/httpd_config.conf && chown lsadm:nogroup /usr/local/lsws/conf/vhosts/turbopanel/vhconf.conf
RUN /build-openlitespeed-docker-${OPENLITESPEED_VERSION}/install_lsphp.sh

RUN rm -rf /build-openlitespeed-docker-${OPENLITESPEED_VERSION}

RUN apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

RUN mkdir /etc/service/openlitespeed
COPY ./image/run_openlitespeed.sh /etc/service/openlitespeed/run
RUN chmod +x /etc/service/openlitespeed/run

COPY ./image/boot_openlitespeed.sh /etc/my_init.d/openlitespeed.sh
RUN chmod +x /etc/my_init.d/openlitespeed.sh
