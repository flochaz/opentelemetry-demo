# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0


FROM golang:1.24-bookworm AS builder

WORKDIR /usr/src/app/

COPY ./go.mod go.mod
COPY ./go.sum go.sum

RUN go mod download

COPY ./genproto/oteldemo/ genproto/oteldemo/
COPY ./products/ products/
COPY ./main.go main.go

RUN CGO_ENABLED=0 GOOS=linux GO111MODULE=on go build -ldflags "-s -w" -o product-catalog main.go

FROM gcr.io/distroless/static-debian12:nonroot

WORKDIR /usr/src/app/


# Copy the built binary and the products directory into the final image
COPY --from=builder /usr/src/app/product-catalog ./product-catalog
COPY --from=builder /usr/src/app/products ./products

# Set default port environment variable
ENV PRODUCT_CATALOG_PORT=3550
EXPOSE 3550
ENTRYPOINT [ "./product-catalog" ]
